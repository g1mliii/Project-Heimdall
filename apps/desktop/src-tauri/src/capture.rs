//! Capture session lifecycle (§21.2, §22.1).
//!
//! Owns the running PresentMon sidecar and the accumulating CSV. The webview
//! sees the session only through events:
//!
//!   capture://started   { pid, process, antiCheat }
//!   capture://rows      { lines, frames }      — live chart + counters
//!   capture://ended     { frames, reason }     — sidecar exited on its own
//!
//! and one command pair (`start_capture` / `stop_capture`). Stop returns the
//! complete CSV, which the webview hands straight to `parseAnyCapture` — the
//! same code path, and the same bytes, the browser upload uses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::activity::{ActivityKind, ActivityPermit, ActivityState};
use crate::error::{AppError, AppResult};
use crate::gpu_telemetry::{GpuTelemetry, TelemetrySampler, SAMPLE_INTERVAL_MS};
use crate::presentmon::{sidecar_args, CaptureBuffer, CaptureTarget, SIDECAR};
use crate::win;

pub const EVENT_STARTED: &str = "capture://started";
pub const EVENT_ROWS: &str = "capture://rows";
pub const EVENT_ENDED: &str = "capture://ended";
const ROW_BATCH_INTERVAL: Duration = Duration::from_millis(50);
const ROW_BATCH_MAX: usize = 256;
const STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStarted {
    pub pid: u32,
    pub process: String,
    /// Advisory anti-cheat notice (§24.4) — never a reason to refuse capture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anti_cheat: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRows {
    /// Rows completed by this chunk, in order.
    pub lines: Vec<String>,
    /// Frame rows accumulated so far (header excluded).
    pub frames: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEnded {
    pub frames: usize,
    /// `exited` (game closed / sidecar stopped) or `overflow` (cap tripped).
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

struct Session {
    /// Keeps capture mutually exclusive with upload and updater installation
    /// until the sidecar and telemetry workers have fully drained.
    _activity: ActivityPermit,
    target: CaptureTarget,
    anti_cheat: Option<String>,
    child: Option<CommandChild>,
    buffer: Arc<Mutex<CaptureBuffer>>,
    /// Cleared on stop; the sampling thread exits when it sees this go false.
    sampling: Arc<AtomicBool>,
    telemetry_thread: Option<JoinHandle<()>>,
    /// Distinguishes a requested stop from a sidecar/game exit, so the stream
    /// task does not tell the webview to call `stop_capture` a second time.
    stop_requested: Arc<AtomicBool>,
    /// Signalled only after the sidecar's stdout receiver has drained.
    stream_done: Option<Receiver<()>>,
}

impl Session {
    fn stop_workers(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        self.sampling.store(false, Ordering::Release);
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
    }

    /// Kill the sidecar, wait for its pipe readers to drain, then join the PDH
    /// sampler. The returned buffer is stable: no task can append another row.
    fn shut_down(mut self) -> AppResult<Arc<Mutex<CaptureBuffer>>> {
        self.stop_workers();
        if let Some(done) = self.stream_done.take() {
            done.recv_timeout(STREAM_DRAIN_TIMEOUT).map_err(|error| {
                AppError::Internal(format!(
                    "PresentMon output did not drain after stop: {error}"
                ))
            })?;
        }
        if let Some(thread) = self.telemetry_thread.take() {
            let _ = thread.join();
        }
        Ok(Arc::clone(&self.buffer))
    }
}

impl Drop for Session {
    /// Backstop for every early-return path after PresentMon has spawned.
    fn drop(&mut self) {
        self.stop_workers();
        if let Some(thread) = self.telemetry_thread.take() {
            let _ = thread.join();
        }
    }
}

/// Managed state. One capture at a time, deliberately: two ETW sessions on the
/// same process fight, and the UI has exactly one capture button.
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

/// Start a capture against whatever is in the foreground.
pub fn start(app: &AppHandle) -> AppResult<CaptureStarted> {
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
) -> AppResult<CaptureStarted> {
    let target = win::foreground_target()?;
    let anti_cheat = win::detect_anti_cheat(target.pid);

    let (mut rx, child) = app
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
                // No GPU counter set on this machine. The capture proceeds with
                // fewer sensors rather than failing — skip, never fail.
                return;
            };
            ready.store(true, Ordering::Release);
            while sampling.load(Ordering::Acquire) {
                std::thread::sleep(std::time::Duration::from_millis(SAMPLE_INTERVAL_MS));
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
    // Give the sampler a moment to open its counters, so the header written on
    // the first stdout chunk already knows whether the columns exist. If it is
    // slower than this the columns are simply omitted for the whole capture,
    // which is honest — better than a header promising values that never come.
    std::thread::sleep(std::time::Duration::from_millis(60));

    let mut buffer = CaptureBuffer::default();
    if telemetry_ready.load(Ordering::Acquire) {
        buffer = buffer.with_telemetry();
    }
    let buffer = Arc::new(Mutex::new(buffer));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let (stream_done_tx, stream_done_rx) = mpsc::channel();
    state.install(
        reservation,
        Session {
            _activity: activity,
            target: target.clone(),
            anti_cheat: anti_cheat.clone(),
            child: Some(child),
            buffer: Arc::clone(&buffer),
            sampling: Arc::clone(&sampling),
            telemetry_thread: Some(telemetry_thread),
            stop_requested: Arc::clone(&stop_requested),
            stream_done: Some(stream_done_rx),
        },
    )?;

    // Publish the start before the stream task can publish an immediate exit.
    // The invoke result carries the same value for hardware collection, but
    // the event is the single source of truth for the reducer (including
    // captures started from the global hotkey).
    let started = CaptureStarted {
        pid: target.pid,
        process: target.process,
        anti_cheat,
    };
    let _ = app.emit(EVENT_STARTED, started.clone());

    // Stream stdout on Tauri's async runtime. PresentMon's plugin reader emits
    // one event per CSV row; coalesce those rows before crossing into the
    // webview so a high-FPS title does not generate thousands of IPC messages.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _completion = CompletionSender(Some(stream_done_tx));
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
                if !stop_requested.load(Ordering::Acquire) {
                    let _ = app_handle.emit(
                        EVENT_ENDED,
                        CaptureEnded {
                            frames: last_frames,
                            reason: "exited",
                        },
                    );
                }
                break;
            };
            match event {
                CommandEvent::Stdout(bytes) => {
                    let chunk = String::from_utf8(bytes).unwrap_or_else(|error| {
                        String::from_utf8_lossy(error.as_bytes()).into_owned()
                    });
                    let sample = latest.lock().ok().and_then(|slot| *slot);
                    let (lines, frames, overflowed) = {
                        let Ok(mut buffer) = buffer.lock() else { break };
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
                        let _ = app_handle.emit(
                            EVENT_ENDED,
                            CaptureEnded {
                                frames,
                                reason: "overflow",
                            },
                        );
                        break;
                    }
                }
                CommandEvent::Terminated(_) => {
                    let frames = buffer.lock().map(|b| b.frame_count()).unwrap_or(0);
                    emit_rows(&app_handle, &mut batch, frames);
                    if !stop_requested.load(Ordering::Acquire) {
                        let _ = app_handle.emit(
                            EVENT_ENDED,
                            CaptureEnded {
                                frames,
                                reason: "exited",
                            },
                        );
                    }
                    break;
                }
                // Stderr is PresentMon's own diagnostics; it goes to the debug
                // console rather than the UI, which has no room for it.
                _ => {}
            }
        }
    });

    Ok(started)
}

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

/// Stop the running capture and hand back the complete CSV.
pub fn stop(app: &AppHandle) -> AppResult<CaptureResult> {
    let state = app.state::<CaptureState>();
    let session = state.take_running()?;

    let target = session.target.clone();
    let anti_cheat = session.anti_cheat.clone();
    let held = session.shut_down()?;
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
/// session open and make the next launch fail.
pub fn abort(app: &AppHandle) {
    let Some(state) = app.try_state::<CaptureState>() else {
        return;
    };
    if let Some(session) = state.take_for_abort() {
        let _ = session.shut_down();
    }
}

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
}
