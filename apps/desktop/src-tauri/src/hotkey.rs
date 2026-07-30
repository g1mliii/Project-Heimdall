//! Global capture hotkey (§21.3).
//!
//! Default Shift+F11, rebindable and persisted via tauri-plugin-store. The
//! whole point of the client is hands-free capture while a game has focus, so
//! the hotkey is not a convenience — a failure to register it is a first-class
//! UI state, never a crash and never a silent no-op. Another app already owning
//! the combination is the common case (overlays love the F-keys), and the user
//! can only fix what they are told about.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::error::{AppError, AppResult};

pub const DEFAULT_HOTKEY: &str = "Shift+F11";
pub const EVENT_HOTKEY: &str = "capture://hotkey";
pub const EVENT_HOTKEY_STATE: &str = "capture://hotkey-state";

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "captureHotkey";

/// What the UI renders in the "Capture" hardware row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum HotkeyState {
    /// Registered and live.
    Registered { accelerator: String },
    /// The combination is owned by something else. Named, not swallowed.
    Conflict {
        accelerator: String,
        message: String,
    },
    /// The platform refused for some other reason.
    Unavailable {
        accelerator: String,
        message: String,
    },
}

impl HotkeyState {
    pub fn accelerator(&self) -> &str {
        match self {
            Self::Registered { accelerator }
            | Self::Conflict { accelerator, .. }
            | Self::Unavailable { accelerator, .. } => accelerator,
        }
    }

    pub fn is_registered(&self) -> bool {
        matches!(self, Self::Registered { .. })
    }
}

#[derive(Default)]
pub struct HotkeyManager {
    current: Mutex<Option<HotkeyState>>,
}

impl HotkeyManager {
    pub fn state(&self) -> Option<HotkeyState> {
        self.current.lock().ok().and_then(|value| value.clone())
    }
}

/// Read the persisted accelerator, falling back to the default.
pub fn persisted_accelerator(app: &AppHandle) -> String {
    tauri_plugin_store::StoreExt::store(app, STORE_FILE)
        .ok()
        .and_then(|store| store.get(STORE_KEY))
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

fn persist_accelerator(app: &AppHandle, accelerator: &str) -> AppResult<()> {
    let store = tauri_plugin_store::StoreExt::store(app, STORE_FILE)
        .map_err(|error| AppError::Settings(error.to_string()))?;
    store.set(
        STORE_KEY,
        serde_json::Value::String(accelerator.to_string()),
    );
    store
        .save()
        .map_err(|error| AppError::Settings(error.to_string()))
}

/// Register `accelerator`, replacing whatever is currently bound.
///
/// Returns the resulting state instead of an error on a conflict: "the hotkey
/// is taken" is information the user needs on screen, not an exception that
/// aborts startup and leaves the window blank.
pub fn apply(app: &AppHandle, accelerator: &str) -> HotkeyState {
    let manager = app.state::<HotkeyManager>();
    let shortcuts = app.global_shortcut();

    // Drop the previous binding first; re-registering over a live one fails.
    if let Some(previous) = manager.state() {
        if previous.is_registered() {
            if let Ok(parsed) = previous.accelerator().parse::<Shortcut>() {
                let _ = shortcuts.unregister(parsed);
            }
        }
    }

    let state = match accelerator.parse::<Shortcut>() {
        Err(error) => HotkeyState::Unavailable {
            accelerator: accelerator.to_string(),
            message: format!("{accelerator} is not a valid shortcut: {error}"),
        },
        Ok(parsed) => {
            let handle = app.clone();
            match shortcuts.on_shortcut(parsed, move |_, _, event| {
                // Fire on press only: a key-up would immediately toggle the
                // capture straight back off.
                if event.state() == ShortcutState::Pressed {
                    let _ = handle.emit(EVENT_HOTKEY, ());
                }
            }) {
                Ok(()) => HotkeyState::Registered {
                    accelerator: accelerator.to_string(),
                },
                Err(error) => HotkeyState::Conflict {
                    accelerator: accelerator.to_string(),
                    message: format!(
                        "{accelerator} is already held by another application ({error}). \
                         Pick a different combination, or close the app that owns it."
                    ),
                },
            }
        }
    };

    if let Ok(mut current) = manager.current.lock() {
        *current = Some(state.clone());
    }
    let _ = app.emit(EVENT_HOTKEY_STATE, state.clone());
    state
}

/// Rebind and persist. The new binding survives a restart even if it failed to
/// register now — the conflicting app may not be running next time.
pub fn rebind(app: &AppHandle, accelerator: &str) -> AppResult<HotkeyState> {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Err(AppError::Hotkey("no shortcut was given".into()));
    }
    persist_accelerator(app, accelerator)?;
    Ok(apply(app, accelerator))
}
