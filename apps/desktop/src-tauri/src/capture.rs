//! Capture session lifecycle (§21.2, §22.1, §23.1).
//!
//! Owns the session, the event contract and the accumulating CSV. The *platform*
//! decides only how rows arrive; everything about what a session is, when it
//! ends and what it hands back is here and is shared.
//!
//! The webview sees the session through events:
//!
//!   capture://armed     { logDirs, hint }        — Linux only, see below
//!   capture://started   { pid, process, antiCheat }
//!   capture://rows      { lines, frames }        — live chart + counters
//!   capture://ended     { frames, reason }       — the source stopped on its own
//!
//! and one command pair (`start_capture` / `stop_capture`). Stop returns the
//! complete CSV, which the webview hands straight to `parseAnyCapture` — the
//! same code path, and the same bytes, the browser upload uses.
//!
//! ── The two backends ────────────────────────────────────────────────────────
//!
//! **Windows** spawns the bundled PresentMon sidecar against the foreground
//! process and pumps its stdout. `start_capture` returning means rows are
//! already flowing.
//!
//! **Linux** does not spawn anything. MangoHud belongs to the user and is driven
//! by MangoHud's own logging hotkey (§23.1), so `start_capture` *arms a watcher*
//! and returns `Armed`. `capture://started` then fires later, if and when a log
//! appears. This is why the event contract grew `capture://armed`: "the client
//! is waiting for you to press MangoHud's hotkey" is a real state the UI has to
//! be able to render, and collapsing it into `started` would show a running
//! timer over a capture that has not begun.
//!
//! Everything after the bytes — parse, sign, upload — is identical on both.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::activity::{ActivityKind, ActivityPermit, ActivityState};
use crate::error::{AppError, AppResult};
use crate::stream::{CaptureBuffer, CaptureTarget};

pub const EVENT_ARMED: &str = "capture://armed";
pub const EVENT_STARTED: &str = "capture://started";
pub const EVENT_ROWS: &str = "capture://rows";
pub const EVENT_ENDED: &str = "capture://ended";
// Coalescing bounds for the PresentMon sidecar's stdout, which emits one event
// per CSV row. The Linux watcher needs neither: its own 500 ms poll is already
// far coarser than any batch window these would impose.
#[cfg_attr(not(windows), allow(dead_code))]
const ROW_BATCH_INTERVAL: Duration = Duration::from_millis(50);
#[cfg_attr(not(windows), allow(dead_code))]
const ROW_BATCH_MAX: usize = 256;
const STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStarted {
    /// 0 when the backend cannot name a process — the Linux watcher sees a log
    /// file, not a game. 0 is never a real pid, so no extra field is needed.
    pub pid: u32,
    pub process: String,
    /// Advisory anti-cheat notice (§24.4) — never a reason to refuse capture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anti_cheat: Option<String>,
    /// Observed Steam build for the captured process (§8.8a).
    ///
    /// Absent for a non-Steam game, an unfindable Steam install, and every
    /// Linux capture (the watcher reports pid 0, so there is no process to
    /// resolve). Absent must read as "unknown", never as "not on Steam".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steam_build: Option<crate::steam::SteamBuild>,
}

/// The watcher is live but MangoHud has not written a log yet (§23.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureArmed {
    /// Every folder being scanned, so the UI can name them if nothing appears.
    pub log_dirs: Vec<String>,
    /// What the user has to do next, in their own terms.
    pub hint: String,
    /// Whether a periodic `log_interval` is configured. When it is not, the
    /// Capturing screen must not promise a live trace (§23.1).
    pub live_trace_expected: bool,
}

/// What `start_capture` resolved to. A tagged union rather than a nullable pair:
/// the two outcomes mean genuinely different things to the UI, and a shape that
/// allows both or neither would let a bug render a running timer over a capture
/// that never started.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CaptureStart {
    /// Rows are flowing. Produced by the Windows backend, whose sidecar is up by
    /// the time `start_capture` returns; on Linux this state is reached later,
    /// through the `capture://started` event rather than the command's result.
    #[cfg_attr(not(windows), allow(dead_code))]
    Started(CaptureStarted),
    /// Waiting for the user to start MangoHud's log. Only the Linux backend
    /// produces this; the variant and its payload still compile everywhere so
    /// the wire contract has one definition and one test.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Armed(CaptureArmed),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRows {
    /// Rows completed by this chunk, in order.
    pub lines: Vec<String>,
    /// Frame rows accumulated so far (header and preamble excluded).
    pub frames: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEnded {
    pub frames: usize,
    /// `exited` (game closed / sidecar stopped / log quiesced) or `overflow`
    /// (the retained-size cap tripped).
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub target: CaptureTarget,
    pub frames: usize,
    /// The complete capture as CSV, for `parseAnyCapture` in the webview.
    pub csv: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anti_cheat: Option<String>,
}

/// Shared handles the pump writes into. One struct so the two pumps take the
/// same argument and the platform code cannot forget one of them.
///
/// Not every backend needs every handle — the Windows sidecar knows its target
/// and its source is live before the pump starts — so some fields have no reader
/// on some platforms.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct PumpCtx {
    /// Filled in by the Linux watcher once it knows which log it is reading;
    /// set once at prepare time on Windows.
    target: Arc<Mutex<CaptureTarget>>,
    buffer: Arc<Mutex<CaptureBuffer>>,
    /// Distinguishes a requested stop from a source exit, so the pump does not
    /// tell the webview to call `stop_capture` a second time.
    stop_requested: Arc<AtomicBool>,
    /// False until a row source actually materialized. On Linux that means a
    /// MangoHud log was found; stopping without one is `NoCaptureLog` rather
    /// than an empty capture, so the error can name MangoHud's hotkey.
    source_found: Arc<AtomicBool>,
    /// Signalled once the pump has finished, so stop can read a stable buffer.
    done: Sender<()>,
}

struct Session {
    /// Keeps capture mutually exclusive with upload and updater installation
    /// until every worker has fully drained.
    _activity: ActivityPermit,
    target: Arc<Mutex<CaptureTarget>>,
    anti_cheat: Option<String>,
    buffer: Arc<Mutex<CaptureBuffer>>,
    stop_requested: Arc<AtomicBool>,
    source_found: Arc<AtomicBool>,
    /// Platform workers started before the session was installed.
    workers: Workers,
    /// Signalled only after the pump has drained.
    stream_done: Option<Receiver<()>>,
}

impl Session {
    fn stop_workers(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        self.workers.signal_stop();
    }

    /// Stop the source, wait for the pump to drain, then join the platform
    /// workers. The returned buffer is stable: nothing can append another row.
    fn shut_down(mut self) -> AppResult<Arc<Mutex<CaptureBuffer>>> {
        self.stop_workers();
        if let Some(done) = self.stream_done.take() {
            done.recv_timeout(STREAM_DRAIN_TIMEOUT).map_err(|error| {
                AppError::Internal(format!(
                    "the capture stream did not drain after stop: {error}"
                ))
            })?;
        }
        self.workers.join();
        Ok(Arc::clone(&self.buffer))
    }
}

impl Drop for Session {
    /// Backstop for every early-return path after the source has started.
    fn drop(&mut self) {
        self.stop_workers();
        self.workers.join();
    }
}

/// Managed state. One capture at a time, deliberately: two ETW sessions on the
/// same process fight, two watchers on one log folder would both claim it, and
/// the UI has exactly one capture button.
#[derive(Default)]
enum CaptureSlot {
    #[default]
    Idle,
    Starting(Arc<AtomicBool>),
    Running(Session),
}

#[derive(Default)]
pub struct CaptureState {
    session: Mutex<CaptureSlot>,
}

impl CaptureState {
    pub fn is_running(&self) -> bool {
        self.session
            .lock()
            .is_ok_and(|session| !matches!(*session, CaptureSlot::Idle))
    }

    fn reserve_start(&self) -> AppResult<Arc<AtomicBool>> {
        let mut slot = self
            .session
            .lock()
            .map_err(|_| AppError::Internal("capture state is poisoned".into()))?;
        if !matches!(*slot, CaptureSlot::Idle) {
            return Err(AppError::CaptureBusy);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *slot = CaptureSlot::Starting(Arc::clone(&cancelled));
        Ok(cancelled)
    }

    fn cancel_start(&self, reservation: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.session.lock() {
            if matches!(
                &*slot,
                CaptureSlot::Starting(current) if Arc::ptr_eq(current, reservation)
            ) {
                *slot = CaptureSlot::Idle;
            }
        }
    }

    fn install(&self, reservation: &Arc<AtomicBool>, session: Session) -> AppResult<()> {
        let mut slot = self
            .session
            .lock()
            .map_err(|_| AppError::Internal("capture state is poisoned".into()))?;
        if !matches!(
            &*slot,
            CaptureSlot::Starting(current)
                if Arc::ptr_eq(current, reservation)
                    && !reservation.load(Ordering::Acquire)
        ) {
            return Err(AppError::Internal(
                "capture start reservation was lost".into(),
            ));
        }
        *slot = CaptureSlot::Running(session);
        Ok(())
    }

    fn take_running(&self) -> AppResult<Session> {
        let mut slot = self
            .session
            .lock()
            .map_err(|_| AppError::Internal("capture state is poisoned".into()))?;
        match std::mem::take(&mut *slot) {
            CaptureSlot::Running(session) => Ok(session),
            CaptureSlot::Starting(reservation) => {
                *slot = CaptureSlot::Starting(reservation);
                Err(AppError::CaptureBusy)
            }
            CaptureSlot::Idle => Err(AppError::CaptureIdle),
        }
    }

    fn take_for_abort(&self) -> Option<Session> {
        let mut slot = self.session.lock().ok()?;
        match std::mem::take(&mut *slot) {
            CaptureSlot::Running(session) => Some(session),
            CaptureSlot::Starting(reservation) => {
                reservation.store(true, Ordering::Release);
                None
            }
            CaptureSlot::Idle => None,
        }
    }
}

/// What the platform backend produced before the session was installed.
struct Prepared {
    workers: Workers,
    /// The best target the backend can name yet. A placeholder on Linux until
    /// the watcher picks a log.
    target: CaptureTarget,
    anti_cheat: Option<String>,
    buffer: CaptureBuffer,
    /// Whether a row source is already live. Windows: yes, the sidecar is up.
    source_found: bool,
    /// What `start_capture` returns and which event announces the session.
    start: CaptureStart,
    /// Handed to `run_pump` once the session is installed.
    pump: Pump,
}

/// Start a capture (Windows) or arm the watcher (Linux).
pub fn start(app: &AppHandle) -> AppResult<CaptureStart> {
    let activity = app
        .state::<ActivityState>()
        .reserve(ActivityKind::Capture)?;
    let state = app.state::<CaptureState>();
    let reservation = state.reserve_start()?;
    let result = start_reserved(app, &state, &reservation, activity);
    if result.is_err() {
        state.cancel_start(&reservation);
    }
    result
}

fn start_reserved(
    app: &AppHandle,
    state: &CaptureState,
    reservation: &Arc<AtomicBool>,
    activity: ActivityPermit,
) -> AppResult<CaptureStart> {
    let prepared = prepare(app)?;

    let target = Arc::new(Mutex::new(prepared.target));
    let buffer = Arc::new(Mutex::new(prepared.buffer));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let source_found = Arc::new(AtomicBool::new(prepared.source_found));
    let (stream_done_tx, stream_done_rx) = mpsc::channel();

    state.install(
        reservation,
        Session {
            _activity: activity,
            target: Arc::clone(&target),
            anti_cheat: prepared.anti_cheat.clone(),
            buffer: Arc::clone(&buffer),
            stop_requested: Arc::clone(&stop_requested),
            source_found: Arc::clone(&source_found),
            workers: prepared.workers,
            stream_done: Some(stream_done_rx),
        },
    )?;

    // Publish the state before the pump can publish an immediate exit. The
    // invoke result carries the same value, but the event is the single source
    // of truth for the reducer (including captures started from the hotkey).
    match &prepared.start {
        CaptureStart::Started(started) => {
            let _ = app.emit(EVENT_STARTED, started.clone());
        }
        CaptureStart::Armed(armed) => {
            let _ = app.emit(EVENT_ARMED, armed.clone());
        }
    }

    run_pump(
        app,
        prepared.pump,
        PumpCtx {
            target,
            buffer,
            stop_requested,
            source_found,
            done: stream_done_tx,
        },
    );

    Ok(prepared.start)
}

/// Signals completion however the pump exits, including a panic.
struct CompletionSender(Option<Sender<()>>);

impl Drop for CompletionSender {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

fn emit_rows(app: &AppHandle, batch: &mut Vec<String>, frames: usize) {
    if batch.is_empty() {
        return;
    }
    let _ = app.emit(
        EVENT_ROWS,
        CaptureRows {
            lines: std::mem::take(batch),
            frames,
        },
    );
}

fn emit_ended(app: &AppHandle, ctx: &PumpCtx, frames: usize, reason: &'static str) {
    if ctx.stop_requested.load(Ordering::Acquire) {
        return;
    }
    let _ = app.emit(EVENT_ENDED, CaptureEnded { frames, reason });
}

/// Stop the running capture and hand back the complete CSV.
pub fn stop(app: &AppHandle) -> AppResult<CaptureResult> {
    let state = app.state::<CaptureState>();
    let session = state.take_running()?;

    let target = session
        .target
        .lock()
        .map(|target| target.clone())
        .map_err(|_| AppError::Internal("capture target is poisoned".into()))?;
    let anti_cheat = session.anti_cheat.clone();
    let source_found = session.source_found.load(Ordering::Acquire);
    let held = session.shut_down()?;

    // No row source ever appeared. Reported as its own failure so the message
    // can name MangoHud's logging hotkey — "0 frames" would send the user
    // looking for a Heimdall bug instead of at the thing they have to press.
    if !source_found {
        return Err(AppError::NoCaptureLog);
    }

    let (frames, csv) = match Arc::try_unwrap(held) {
        Ok(buffer) => {
            let buffer = buffer
                .into_inner()
                .map_err(|_| AppError::Internal("capture buffer is poisoned".into()))?;
            (buffer.frame_count(), buffer.into_csv())
        }
        Err(held) => {
            // Completion was observed, so this is only a defensive fallback
            // for an unexpected extra owner, not a concurrently-mutating read.
            let buffer = held
                .lock()
                .map_err(|_| AppError::Internal("capture buffer is poisoned".into()))?;
            (buffer.frame_count(), buffer.csv().to_owned())
        }
    };

    Ok(CaptureResult {
        target,
        frames,
        csv,
        anti_cheat,
    })
}

/// Best-effort teardown for app exit. A surviving PresentMon would keep an ETW
/// session open and make the next launch fail; a surviving watcher thread would
/// hold the activity permit.
pub fn abort(app: &AppHandle) {
    let Some(state) = app.try_state::<CaptureState>() else {
        return;
    };
    if let Some(session) = state.take_for_abort() {
        let _ = session.shut_down();
    }
}

// ── Windows backend: the PresentMon sidecar ─────────────────────────────────

#[cfg(windows)]
mod backend {
    use super::*;

    use std::thread::JoinHandle;

    use tauri_plugin_shell::process::{CommandChild, CommandEvent};
    use tauri_plugin_shell::ShellExt;

    use crate::gpu_telemetry::{GpuTelemetry, TelemetrySampler, SAMPLE_INTERVAL_MS};
    use crate::presentmon::{sidecar_args, SIDECAR};
    use crate::win;

    /// Threads and children owned for the session's lifetime.
    pub struct Workers {
        pub child: Option<CommandChild>,
        /// Cleared on stop; the sampling thread exits when it sees this go false.
        pub sampling: Arc<AtomicBool>,
        pub telemetry_thread: Option<JoinHandle<()>>,
    }

    impl Workers {
        pub fn signal_stop(&mut self) {
            self.sampling.store(false, Ordering::Release);
            if let Some(child) = self.child.take() {
                let _ = child.kill();
            }
        }

        pub fn join(&mut self) {
            if let Some(thread) = self.telemetry_thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// The sidecar's stdout stream plus the counter slot its rows are annotated
    /// with.
    pub struct Pump {
        pub rx: tauri::async_runtime::Receiver<CommandEvent>,
        pub latest: Arc<Mutex<Option<GpuTelemetry>>>,
    }

    pub fn prepare(app: &AppHandle) -> AppResult<Prepared> {
        let target = win::foreground_target()?;
        let anti_cheat = win::detect_anti_cheat(target.pid);

        let (rx, child) = app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|error| AppError::Sidecar(error.to_string()))?
            .args(sidecar_args(&target))
            .spawn()
            .map_err(|error| AppError::Sidecar(error.to_string()))?;

        // GPU telemetry (§22.2). PresentMon supplies none, so the client samples
        // Windows performance counters itself. The sampler is built ON the worker
        // thread: PDH handles are raw pointers and therefore not `Send`.
        let latest = Arc::new(Mutex::new(None::<GpuTelemetry>));
        let sampling = Arc::new(AtomicBool::new(true));
        let telemetry_ready = Arc::new(AtomicBool::new(false));
        let telemetry_thread = {
            let latest = Arc::clone(&latest);
            let sampling = Arc::clone(&sampling);
            let ready = Arc::clone(&telemetry_ready);
            let pid = target.pid;
            std::thread::spawn(move || {
                let Some(sampler) = TelemetrySampler::new(pid) else {
                    // No GPU counter set on this machine. The capture proceeds
                    // with fewer sensors rather than failing — skip, never fail.
                    return;
                };
                ready.store(true, Ordering::Release);
                while sampling.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(SAMPLE_INTERVAL_MS));
                    if !sampling.load(Ordering::Acquire) {
                        break;
                    }
                    let sample = sampler.sample();
                    if let Ok(mut slot) = latest.lock() {
                        *slot = Some(sample);
                    }
                }
            })
        };
        // Give the sampler a moment to open its counters, so the header written
        // on the first stdout chunk already knows whether the columns exist. If
        // it is slower than this the columns are simply omitted for the whole
        // capture, which is honest — better than a header promising values that
        // never come.
        std::thread::sleep(Duration::from_millis(60));

        let mut buffer = CaptureBuffer::default();
        if telemetry_ready.load(Ordering::Acquire) {
            buffer = buffer.with_telemetry();
        }

        Ok(Prepared {
            workers: Workers {
                child: Some(child),
                sampling,
                telemetry_thread: Some(telemetry_thread),
            },
            target: target.clone(),
            anti_cheat: anti_cheat.clone(),
            buffer,
            // The sidecar is running; rows are on their way.
            source_found: true,
            start: CaptureStart::Started(CaptureStarted {
                pid: target.pid,
                // One file read against the local Steam install; nothing here
                // touches the network, and every failure yields None.
                steam_build: crate::steam::detect(target.pid),
                process: target.process,
                anti_cheat,
            }),
            pump: Pump { rx, latest },
        })
    }

    /// Stream stdout on Tauri's async runtime. PresentMon's plugin reader emits
    /// one event per CSV row; coalesce those rows before crossing into the
    /// webview so a high-FPS title does not generate thousands of IPC messages.
    pub fn run_pump(app: &AppHandle, pump: Pump, ctx: PumpCtx) {
        let Pump { mut rx, latest } = pump;
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _completion = CompletionSender(Some(ctx.done.clone()));
            let mut batch = Vec::new();
            let mut last_frames = 0usize;
            let mut deadline = tokio::time::Instant::now() + ROW_BATCH_INTERVAL;
            loop {
                let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
                        emit_rows(&app_handle, &mut batch, last_frames);
                        deadline = tokio::time::Instant::now() + ROW_BATCH_INTERVAL;
                        continue;
                    }
                };
                let Some(event) = event else {
                    emit_rows(&app_handle, &mut batch, last_frames);
                    emit_ended(&app_handle, &ctx, last_frames, "exited");
                    break;
                };
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let chunk = String::from_utf8(bytes).unwrap_or_else(|error| {
                            String::from_utf8_lossy(error.as_bytes()).into_owned()
                        });
                        let sample = latest.lock().ok().and_then(|slot| *slot);
                        let (lines, frames, overflowed) = {
                            let Ok(mut buffer) = ctx.buffer.lock() else {
                                break;
                            };
                            let lines = buffer.push_with_telemetry(&chunk, sample);
                            (lines, buffer.frame_count(), buffer.overflowed())
                        };
                        last_frames = frames;
                        batch.extend(lines);
                        if batch.len() >= ROW_BATCH_MAX {
                            emit_rows(&app_handle, &mut batch, frames);
                            deadline = tokio::time::Instant::now() + ROW_BATCH_INTERVAL;
                        }
                        if overflowed {
                            emit_rows(&app_handle, &mut batch, frames);
                            emit_ended(&app_handle, &ctx, frames, "overflow");
                            break;
                        }
                    }
                    CommandEvent::Terminated(_) => {
                        let frames = ctx.buffer.lock().map(|b| b.frame_count()).unwrap_or(0);
                        emit_rows(&app_handle, &mut batch, frames);
                        emit_ended(&app_handle, &ctx, frames, "exited");
                        break;
                    }
                    // Stderr is PresentMon's own diagnostics; it goes to the
                    // debug console rather than the UI, which has no room for it.
                    _ => {}
                }
            }
        });
    }
}

// ── Linux backend: the MangoHud watcher ─────────────────────────────────────

#[cfg(target_os = "linux")]
mod backend {
    use super::*;

    use std::io::{Read, Seek, SeekFrom};
    use std::path::PathBuf;
    use std::time::{Instant, SystemTime};

    use crate::mangohud::{self, LogCandidate, MangoHudParams, POLL_INTERVAL, PREAMBLE_ROWS};

    /// Bytes of a candidate file read to decide whether it is a MangoHud log.
    /// Enough to reach the frame header past the sysinfo rows without pulling a
    /// large file into memory on every 500 ms poll.
    const SNIFF_BYTES: usize = 4096;

    /// Nothing to own: the watcher IS the pump, and it is stopped through
    /// `stop_requested` and drained through the completion channel — the same
    /// mechanism the Windows stdout task uses.
    pub struct Workers;

    impl Workers {
        pub fn signal_stop(&mut self) {}
        pub fn join(&mut self) {}
    }

    pub struct Pump {
        pub dirs: Vec<PathBuf>,
        pub armed_at: SystemTime,
    }

    /// Read every config MangoHud might apply, host and Flatpak Steam alike.
    fn resolve_configs() -> Vec<MangoHudParams> {
        let env = mangohud::ConfigEnv::from_process();
        let inline = env
            .inline
            .as_deref()
            .map(MangoHudParams::parse)
            .unwrap_or_default();
        let mut configs: Vec<MangoHudParams> = mangohud::config_candidates(&env)
            .into_iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .map(|text| MangoHudParams::parse(&text))
            // `MANGOHUD_CONFIG` overrides each file per-parameter, so a launch
            // option that sets only `output_folder` keeps the file's interval.
            .map(|file| inline.clone().overlay(file))
            .collect();
        if configs.is_empty() && !inline.is_empty() {
            configs.push(inline);
        }
        configs
    }

    pub fn prepare(_app: &AppHandle) -> AppResult<Prepared> {
        let configs = resolve_configs();
        let dirs = mangohud::log_dir_candidates(&configs);
        if dirs.is_empty() {
            // The hard onboarding gate (§23.1): with no `output_folder`,
            // MangoHud writes beside the game's working directory and there is
            // nothing for the watcher to watch. Refusing here — with the line
            // to add — beats arming a watcher that can never fire.
            return Err(AppError::NoLogFolder);
        }
        let live_trace_expected = configs.iter().any(|c| c.log_interval_ms().is_some());

        Ok(Prepared {
            workers: Workers,
            // Named by the watcher once it picks a log; until then the run has
            // no game name to show, and inventing one would prefill the upload
            // form with a guess.
            target: CaptureTarget {
                pid: 0,
                process: String::new(),
            },
            // MangoHud does not report anti-cheat modules and Heimdall does not
            // inspect the game's process on Linux, so this stays absent rather
            // than being reported as "none detected".
            anti_cheat: None,
            buffer: CaptureBuffer::default().with_preamble_rows(PREAMBLE_ROWS),
            source_found: false,
            start: CaptureStart::Armed(CaptureArmed {
                log_dirs: dirs.iter().map(|dir| dir.display().to_string()).collect(),
                hint: "Press MangoHud's logging hotkey in-game to start recording.".into(),
                live_trace_expected,
            }),
            pump: Pump {
                dirs,
                // Anything already on disk is a previous session's log.
                armed_at: SystemTime::now(),
            },
        })
    }

    /// List everything in the watched folders that could be this capture.
    ///
    /// The mtime filter is applied HERE as well as in `select_log`, which is
    /// redundant by design: it is what keeps the sniff off files that cannot win.
    /// Without it, a user with a folder of two hundred previous logs would have
    /// all two hundred opened and read twice a second for as long as the watcher
    /// stayed armed, to reach the same answer.
    fn scan(dirs: &[PathBuf], armed_at: SystemTime) -> Vec<LogCandidate> {
        let mut candidates = Vec::new();
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("csv") {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let Ok(modified) = metadata.modified() else {
                    continue;
                };
                if modified < armed_at {
                    continue;
                }
                candidates.push(LogCandidate {
                    is_mangohud: mangohud::looks_like_mangohud_log(&head_of(&path)),
                    path,
                    modified,
                });
            }
        }
        candidates
    }

    fn head_of(path: &PathBuf) -> String {
        let Ok(mut file) = std::fs::File::open(path) else {
            return String::new();
        };
        let mut bytes = vec![0u8; SNIFF_BYTES];
        let Ok(read) = file.read(&mut bytes) else {
            return String::new();
        };
        bytes.truncate(read);
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Read from `offset` to end of file, returning the bytes and the new offset.
    fn read_tail(path: &PathBuf, offset: u64) -> Option<(String, u64)> {
        let mut file = std::fs::File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        if len <= offset {
            return Some((String::new(), offset));
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = Vec::with_capacity((len - offset) as usize);
        file.read_to_end(&mut bytes).ok()?;
        let read = bytes.len() as u64;
        // Lossy on purpose: a partial multi-byte character at the chunk
        // boundary is not worth failing a capture over, and `CaptureBuffer`
        // only commits whole lines anyway.
        Some((String::from_utf8_lossy(&bytes).into_owned(), offset + read))
    }

    /// Watch the resolved folders for a log, then tail it (§23.1).
    ///
    /// Polling rather than inotify: no new crate, no per-user watch limits, and
    /// no Flatpak portal complications, for a cost that only exists between arm
    /// and stop. The tail reads go through `CaptureBuffer::push`, so they get
    /// exactly the same line framing the Windows sidecar's stdout does.
    pub fn run_pump(app: &AppHandle, pump: Pump, ctx: PumpCtx) {
        let app = app.clone();
        std::thread::spawn(move || {
            let _completion = CompletionSender(Some(ctx.done.clone()));
            let mut current: Option<PathBuf> = None;
            let mut offset = 0u64;
            let mut last_len = 0u64;
            let mut stable_since = Instant::now();
            let mut batch: Vec<String> = Vec::new();
            let mut frames = 0usize;

            while !ctx.stop_requested.load(Ordering::Acquire) {
                std::thread::sleep(POLL_INTERVAL);
                if ctx.stop_requested.load(Ordering::Acquire) {
                    break;
                }

                let Some(path) = current.clone() else {
                    let candidates = scan(&pump.dirs, pump.armed_at);
                    let Some(selected) = mangohud::select_log(&candidates, pump.armed_at) else {
                        continue;
                    };
                    let path = selected.path.clone();
                    let process = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(mangohud::process_from_log_name)
                        .unwrap_or_default();
                    if let Ok(mut target) = ctx.target.lock() {
                        target.process = process.clone();
                    }
                    ctx.source_found.store(true, Ordering::Release);
                    current = Some(path);
                    offset = 0;
                    last_len = 0;
                    stable_since = Instant::now();
                    // Rows are now flowing, which is what `started` means on
                    // both platforms.
                    let _ = app.emit(
                        EVENT_STARTED,
                        CaptureStarted {
                            pid: 0,
                            process,
                            anti_cheat: None,
                            // The watcher sees a log file, not a process, so
                            // there is no pid to resolve an install from.
                            // Build pinning does not apply on this backend.
                            steam_build: None,
                        },
                    );
                    continue;
                };

                let Some((chunk, next_offset)) = read_tail(&path, offset) else {
                    // The log was removed or became unreadable mid-capture.
                    // Whatever was already retained is still a valid capture.
                    emit_rows(&app, &mut batch, frames);
                    emit_ended(&app, &ctx, frames, "exited");
                    break;
                };
                offset = next_offset;

                if !chunk.is_empty() {
                    let (lines, count, overflowed) = {
                        let Ok(mut buffer) = ctx.buffer.lock() else {
                            break;
                        };
                        let lines = buffer.push(&chunk);
                        (lines, buffer.frame_count(), buffer.overflowed())
                    };
                    frames = count;
                    batch.extend(lines);
                    emit_rows(&app, &mut batch, frames);
                    if overflowed {
                        emit_ended(&app, &ctx, frames, "overflow");
                        break;
                    }
                }

                // End on a size that has stopped changing, not on mtime: a
                // filesystem with coarse timestamp granularity can report an
                // unchanged mtime for a file that is still being appended to,
                // and ending a live capture early is the worse failure.
                //
                // Gated on having read at least one frame, which is what makes
                // the no-`log_interval` case work: MangoHud can create the log
                // and then write nothing until the user stops logging, and a
                // quiesce rule that fired on an empty-but-present file would
                // end that capture 2.5 seconds in with zero frames.
                if frames > 0 && next_offset == last_len {
                    if mangohud::has_quiesced(stable_since.elapsed()) {
                        emit_rows(&app, &mut batch, frames);
                        emit_ended(&app, &ctx, frames, "exited");
                        break;
                    }
                } else {
                    last_len = next_offset;
                    stable_since = Instant::now();
                }
            }
            emit_rows(&app, &mut batch, frames);
        });
    }
}

// ── Backends this build has no implementation for ───────────────────────────

#[cfg(not(any(windows, target_os = "linux")))]
mod backend {
    //! macOS and everything else.
    //!
    //! Exists so the crate compiles and `cargo test` runs on a platform Phase
    //! 9.5 does not ship a capture backend for. It refuses rather than
    //! pretending: macOS is Phase 13.

    use super::*;

    pub struct Workers;

    impl Workers {
        pub fn signal_stop(&mut self) {}
        pub fn join(&mut self) {}
    }

    pub struct Pump;

    pub fn prepare(_app: &AppHandle) -> AppResult<Prepared> {
        Err(AppError::Foreground(
            "capture is implemented for Windows and Linux only".into(),
        ))
    }

    pub fn run_pump(_app: &AppHandle, _pump: Pump, ctx: PumpCtx) {
        // Nothing will ever run, but the completion channel must still be
        // signalled or `stop` would block for its full drain timeout.
        let _ = ctx.done.send(());
    }
}

use backend::{prepare, run_pump, Pump, Workers};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_reservation_blocks_every_competing_start() {
        let state = CaptureState::default();
        let reservation = state.reserve_start().unwrap();
        assert_eq!(state.reserve_start().unwrap_err().code(), "capture-busy");
        assert!(state.is_running());
        state.cancel_start(&reservation);
        assert!(!state.is_running());
        state.reserve_start().unwrap();
    }

    #[test]
    fn abort_cancels_the_matching_start_reservation() {
        let state = CaptureState::default();
        let reservation = state.reserve_start().unwrap();

        assert!(state.take_for_abort().is_none());
        assert!(reservation.load(Ordering::Acquire));
        state.reserve_start().unwrap();
    }

    #[test]
    fn the_start_result_distinguishes_a_running_capture_from_an_armed_watcher() {
        // The UI keys a running timer off this. A shape that allowed both or
        // neither would let a bug show elapsed time for a capture that has not
        // begun (§23.1).
        let started = serde_json::to_value(CaptureStart::Started(CaptureStarted {
            pid: 4242,
            process: "Cyberpunk2077.exe".into(),
            anti_cheat: None,
            steam_build: None,
        }))
        .unwrap();
        assert_eq!(started["state"], "started");
        assert_eq!(started["pid"], 4242);
        assert!(started.get("antiCheat").is_none());
        // Absent, not null: the webview must read a missing build as "unknown"
        // rather than as a positive "this is not a Steam game".
        assert!(started.get("steamBuild").is_none());

        let armed = serde_json::to_value(CaptureStart::Armed(CaptureArmed {
            log_dirs: vec!["/home/player/mangologs".into()],
            hint: "Press MangoHud's logging hotkey in-game to start recording.".into(),
            live_trace_expected: false,
        }))
        .unwrap();
        assert_eq!(armed["state"], "armed");
        assert_eq!(armed["logDirs"][0], "/home/player/mangologs");
        // The Capturing screen must not promise a sparkline it cannot draw.
        assert_eq!(armed["liveTraceExpected"], false);
    }
}
