//! The IPC surface (§22.4).
//!
//! Every command returns `Result<_, AppError>`, so the webview gets a
//! `{ code, message }` envelope for every failure and can render a named state
//! instead of a generic "something went wrong".

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

use crate::capture::{self, CaptureResult, CaptureStarted, CaptureState};
use crate::crash;
use crate::error::{AppError, AppResult};
use crate::hardware::{HardwareSnapshot, MethodologyFacts};
use crate::hotkey::{self, HotkeyState};
use crate::presentmon::{capture_tool, SIDECAR};
use crate::signing::PayloadSigner;
use crate::upload::{self, PayloadState, PreparedPayload};
use crate::win;

/// Everything the onboarding screen's checklist needs, in one round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// `None` when membership could not be determined — reported as unknown
    /// rather than as a failure, so the checklist can say so.
    pub performance_log_users: Option<bool>,
    /// Whether the bundled PresentMon sidecar resolves and can be launched.
    pub sidecar_present: bool,
    pub capture_tool: String,
    pub hotkey: HotkeyState,
    pub api_base_url: String,
    pub app_version: String,
    /// True only in builds carrying an embedded key (§22.3). The UI must not
    /// promise a signature it cannot produce.
    pub signing_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredHardware {
    pub hardware: HardwareSnapshot,
    pub methodology: MethodologyFacts,
}

#[tauri::command]
pub fn get_environment(app: AppHandle) -> Environment {
    Environment {
        performance_log_users: win::in_performance_log_users(),
        sidecar_present: app.shell().sidecar(SIDECAR).is_ok(),
        capture_tool: capture_tool(),
        hotkey: app
            .state::<hotkey::HotkeyManager>()
            .state()
            .unwrap_or(HotkeyState::Unavailable {
                accelerator: hotkey::DEFAULT_HOTKEY.into(),
                message: "the hotkey has not been registered yet".into(),
            }),
        api_base_url: upload::api_base_url(),
        app_version: app.package_info().version.to_string(),
        signing_available: PayloadSigner::from_build().is_some(),
    }
}

/// Declared hardware + methodology (§22.2). Read on demand: a user who fixes
/// their RAM speed and reopens the window should see the new value.
///
/// Off the main thread (see `blocking` below): collection is a DXGI enumeration,
/// dozens of registry reads and three WQL queries, and a cold WMI connect alone
/// can take most of a second. On the UI thread that is a frozen window on every
/// launch.
#[tauri::command]
pub async fn get_hardware() -> AppResult<DeclaredHardware> {
    blocking("hardware collection", || {
        let (hardware, methodology) = win::collect_hardware();
        DeclaredHardware {
            hardware,
            methodology,
        }
    })
    .await
}

/// The foreground process, so the "Game" row is live before capture starts.
#[tauri::command]
pub fn get_foreground_game() -> AppResult<crate::presentmon::CaptureTarget> {
    win::foreground_target()
}

/// Start a capture. Off the main thread: this enumerates the game's loaded
/// modules for the anti-cheat notice, spawns the sidecar, and waits 60 ms for
/// the telemetry sampler to open its counters — a UI freeze at the exact moment
/// the user is in a fullscreen game.
#[tauri::command]
pub async fn start_capture(app: AppHandle) -> AppResult<CaptureStarted> {
    blocking("capture start", move || capture::start(&app)).await?
}

/// Stop a capture. Off the main thread: this joins the entire retained capture
/// into one CSV string, which for a long session is tens of megabytes.
#[tauri::command]
pub async fn stop_capture(app: AppHandle) -> AppResult<CaptureResult> {
    blocking("capture stop", move || capture::stop(&app)).await?
}

/// Run blocking work on the blocking pool rather than on Tauri's main thread.
///
/// A synchronous `#[tauri::command]` executes on the main/UI thread, so any
/// registry, WMI, PDH or large-string work inside one freezes the window for
/// its duration.
async fn blocking<T, F>(what: &'static str, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Internal(format!("{what} failed: {error}")))
}

#[tauri::command]
pub fn capture_running(state: State<'_, CaptureState>) -> bool {
    state.is_running()
}

#[tauri::command]
pub fn set_hotkey(app: AppHandle, accelerator: String) -> AppResult<HotkeyState> {
    hotkey::rebind(&app, &accelerator)
}

/// Sign the Parquet and take custody of it — see upload.rs for why these are
/// one command. The body arrives over Tauri's RAW IPC channel; a JSON/base64
/// body would inflate a 64 MiB payload by a third for no benefit.
#[tauri::command]
pub fn prepare_payload(
    request: Request<'_>,
    state: State<'_, PayloadState>,
) -> AppResult<PreparedPayload> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Internal(
            "prepare_payload expects a raw ArrayBuffer body, not JSON".into(),
        ));
    };
    upload::prepare(&state, bytes.clone())
}

#[tauri::command]
pub async fn put_prepared_payload(
    app: AppHandle,
    state: State<'_, PayloadState>,
    url: String,
    content_type: String,
) -> AppResult<()> {
    // The content type comes from the engine, which reads it from
    // `@heimdall/shared` — the same value the presigned URL was signed for. A
    // second copy of the string here would be a 403 the day shared changes.
    upload::put_prepared(&app, &state, &url, &content_type).await
}

/// Drop a discarded capture's bytes without uploading them.
#[tauri::command]
pub fn discard_payload(state: State<'_, PayloadState>) {
    state.clear();
}

/// Claim handoff (§22.5) — hands the plaintext token to the browser and to
/// nowhere else.
#[tauri::command]
pub fn open_claim(app: AppHandle, run_id: String, management_token: String) -> AppResult<()> {
    open_external(&app, &upload::claim_url(&run_id, &management_token))
}

/// Open a documentation link (the onboarding screen's setup guide).
#[tauri::command]
pub fn open_setup_guide(app: AppHandle) -> AppResult<()> {
    open_external(
        &app,
        "https://github.com/g1mliii/Project-Heimdall/blob/main/docs/desktop-client.md",
    )
}

fn open_external(app: &AppHandle, url: &str) -> AppResult<()> {
    tauri_plugin_opener::OpenerExt::opener(app)
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::Internal(format!("could not open the browser: {error}")))
}

/// Base64 DER SPKI public key of this build's signing key, for the operator
/// setting `HEIMDALL_SIGNING_PUBLIC_KEY` on the server. Publishable by design.
#[tauri::command]
pub fn signing_public_key() -> AppResult<String> {
    PayloadSigner::from_build()
        .ok_or(AppError::NoSigningKey)?
        .public_key_spki_base64()
}

/// Most recent local crash log, if the last run ended in a panic (§22.7).
/// Reporting is opt-in: this only reads the file, the user decides whether to
/// send it.
#[tauri::command]
pub fn pending_crash_report(app: AppHandle) -> Option<String> {
    crash::pending_report(&app)
}

#[tauri::command]
pub fn open_crash_report(app: AppHandle, report: String) -> AppResult<()> {
    open_external(&app, &crash::issue_url(&report))?;
    crash::clear(&app);
    Ok(())
}

#[tauri::command]
pub fn dismiss_crash_report(app: AppHandle) {
    crash::clear(&app);
}
