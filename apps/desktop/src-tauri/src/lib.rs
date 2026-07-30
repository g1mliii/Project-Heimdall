//! Heimdall Capture — Tauri 2 application entry point (§21–§22).
//!
//! Division of labour, deliberately: the webview does ALL parsing, metrics and
//! UI with the same `@heimdall/parsers` / `@heimdall/ingest-client` code the web
//! hub runs (§22.1), and this crate does everything the webview cannot do or
//! must not hold — the PresentMon sidecar, foreground-process detection,
//! hardware collection, the Ed25519 private key, and the direct-to-R2 PUT.

mod activity;
mod capture;
mod commands;
mod crash;
mod driver;
mod error;
mod gpu_telemetry;
mod hardware;
mod hotkey;
mod presentmon;
mod signing;
mod upload;
mod win;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// Raised when the tray asks for a capture toggle. The webview owns the state
/// machine, so the tray and the hotkey both just ask it to toggle rather than
/// driving the session behind its back.
const EVENT_TRAY_TOGGLE: &str = "capture://toggle";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // The webview speaks §11 to the hub through this plugin: a plain
        // webview fetch would be blocked by the CSP, which allows no remote
        // origins at all.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(capture::CaptureState::default())
        .manage(activity::ActivityState::default())
        .manage(upload::PayloadState::default())
        .manage(hotkey::HotkeyManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_environment,
            commands::get_hardware,
            commands::get_hardware_for_pid,
            commands::check_for_update,
            commands::install_update,
            commands::get_foreground_game,
            commands::start_capture,
            commands::stop_capture,
            commands::capture_running,
            commands::set_hotkey,
            commands::begin_upload,
            commands::end_upload,
            commands::prepare_payload,
            commands::put_prepared_payload,
            commands::discard_payload,
            commands::open_claim,
            commands::open_setup_guide,
            commands::signing_public_key,
            commands::pending_crash_report,
            commands::open_crash_report,
            commands::dismiss_crash_report,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            crash::install(&handle);

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // Registering the hotkey must never abort startup: a conflict is a
            // UI state the user can act on, and a blank window is not.
            hotkey::apply(&handle, &hotkey::persisted_accelerator(&handle));
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Close hides to tray instead of exiting, so the capture hotkey
                // stays live while the user is in a game. Quit is on the tray.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Heimdall Capture")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // A surviving PresentMon would hold its ETW session open and
                // make the next launch fail.
                capture::abort(app);
            }
        });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Start / stop capture", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &show, &quit])?;

    TrayIconBuilder::with_id("heimdall-capture")
        .icon(
            app.default_window_icon().cloned().ok_or_else(|| {
                tauri::Error::AssetNotFound("the bundle has no window icon".into())
            })?,
        )
        .tooltip("Heimdall Capture")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let _ = app.emit(EVENT_TRAY_TOGGLE, ());
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                capture::abort(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
