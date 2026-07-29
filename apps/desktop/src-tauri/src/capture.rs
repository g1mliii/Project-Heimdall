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
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::error::{AppError, AppResult};
use crate::gpu_telemetry::{GpuTelemetry, TelemetrySampler, SAMPLE_INTERVAL_MS};
use crate::presentmon::{sidecar_args, CaptureBuffer, CaptureTarget, SIDECAR};
use crate::win;

pub const EVENT_STARTED: &str = "capture://started";
pub const EVENT_ROWS: &str = "capture://rows";
pub const EVENT_ENDED: &str = "capture://ended";

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
    target: CaptureTarget,
    anti_cheat: Option<String>,
    child: CommandChild,
    buffer: Arc<Mutex<CaptureBuffer>>,
    /// Cleared on stop; the sampling thread exits when it sees this go false.
    sampling: Arc<AtomicBool>,
}

impl Session {
    /// Stop sampling first, THEN kill the child: the buffer must not be
    /// appended to while it is being drained, or the CSV can end mid-row.
    ///
    /// Both teardown paths (`stop` and `abort`) go through here so that
    /// ordering is stated once rather than depended on twice.
    fn shut_down(self) {
        self.sampling.store(false, Ordering::Release);
        let _ = self.child.kill();
    }
}

/// Managed state. One capture at a time, deliberately: two ETW sessions on the
/// same process fight, and the UI has exactly one capture button.
#[derive(Default)]
pub struct CaptureState {
    session: Mutex<Option<Session>>,
}

impl CaptureState {
    pub fn is_running(&self) -> bool {
        self.session.lock().is_ok_and(|session| session.is_some())
    }
}

/// Start a capture against whatever is in the foreground.
pub fn start(app: &AppHandle) -> AppResult<CaptureStarted> {
    let state = app.state::<CaptureState>();
    {
        let guard = state
            .session
            .lock()
            .map_err(|_| AppError::Internal("capture state is poisoned".into()))?;
        if guard.is_some() {
            return Err(AppError::CaptureBusy);
        }
    }

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
    {
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
        });
    }
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
    {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| AppError::Internal("capture state is poisoned".into()))?;
        *guard = Some(Session {
            target: target.clone(),
            anti_cheat: anti_cheat.clone(),
            child,
            buffer: Arc::clone(&buffer),
            sampling: Arc::clone(&sampling),
        });
    }

    // Stream stdout on Tauri's async runtime. The task owns nothing but a
    // handle and the shared buffer, so a stop that drops the session simply
    // ends the receiver.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let chunk = String::from_utf8_lossy(&bytes).into_owned();
                    let sample = latest.lock().ok().and_then(|slot| *slot);
                    let (lines, frames, overflowed) = {
                        let Ok(mut buffer) = buffer.lock() else { break };
                        let lines = buffer.push_with_telemetry(&chunk, sample);
                        (lines, buffer.frame_count(), buffer.overflowed())
                    };
                    if overflowed {
                        let _ = app_handle.emit(
                            EVENT_ENDED,
                            CaptureEnded {
                                frames,
                                reason: "overflow",
                            },
                        );
                        break;
                    }
                    if !lines.is_empty() {
                        let _ = app_handle.emit(EVENT_ROWS, CaptureRows { lines, frames });
                    }
                }
                CommandEvent::Terminated(_) => {
                    let frames = buffer.lock().map(|b| b.frame_count()).unwrap_or(0);
                    let _ = app_handle.emit(
                        EVENT_ENDED,
                        CaptureEnded {
                            frames,
                            reason: "exited",
                        },
                    );
                    break;
                }
                // Stderr is PresentMon's own diagnostics; it goes to the debug
                // console rather than the UI, which has no room for it.
                _ => {}
            }
        }
    });

    let started = CaptureStarted {
        pid: target.pid,
        process: target.process,
        anti_cheat,
    };
    let _ = app.emit(EVENT_STARTED, started.clone());
    Ok(started)
}

/// Stop the running capture and hand back the complete CSV.
pub fn stop(app: &AppHandle) -> AppResult<CaptureResult> {
    let state = app.state::<CaptureState>();
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Internal("capture state is poisoned".into()))?
        .take()
        .ok_or(AppError::CaptureIdle)?;

    let target = session.target.clone();
    let anti_cheat = session.anti_cheat.clone();
    let held = Arc::clone(&session.buffer);
    session.shut_down();

    let buffer = held
        .lock()
        .map_err(|_| AppError::Internal("capture buffer is poisoned".into()))?;

    Ok(CaptureResult {
        target,
        frames: buffer.frame_count(),
        csv: buffer.to_csv(),
        anti_cheat,
    })
}

/// Best-effort teardown for app exit. A surviving PresentMon would keep an ETW
/// session open and make the next launch fail.
pub fn abort(app: &AppHandle) {
    let Some(state) = app.try_state::<CaptureState>() else {
        return;
    };
    let Ok(mut guard) = state.session.lock() else {
        return;
    };
    if let Some(session) = guard.take() {
        session.shut_down();
    }
}
