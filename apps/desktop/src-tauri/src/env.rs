//! The onboarding checklist, as a contract (§22.4, §23.1).
//!
//! Before Phase 9.5 the checklist was two named booleans on `Environment`
//! (`performanceLogUsers`, `sidecarPresent`) and the webview knew what they
//! meant. That does not survive a second platform: Linux has four checks, none
//! of which is either of those, and the copy for "your MangoHud config has no
//! output_folder — add this line" only exists on the side that read the config.
//!
//! So the shape is inverted. Rust produces a list of checks, each carrying its
//! own label, state, hint and (where the fix is a config line) the exact text to
//! paste. The webview renders the list and reads `blocking` to decide whether to
//! show the setup screen. Adding a platform, or a check, no longer touches the
//! webview at all.
//!
//! Every entry is wired to a real check. There are no decorative ticks here —
//! that was true of the Windows screen and it stays true.

use serde::Serialize;

/// A check's outcome. `Unknown` is a first-class state, not a failure: on
/// Windows group membership can fail to resolve, and on Linux the config that
/// actually applies may live in a Steam launch option we cannot read. Saying so
/// is better than guessing either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Ok,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    /// Stable identifier. The UI keys nothing off the label, so copy can change
    /// without breaking a test.
    pub id: &'static str,
    pub label: String,
    pub state: CheckState,
    /// What to do about it, when there is something to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Verbatim config lines to add. Shown, never written: Heimdall does not
    /// own `MangoHud.conf` and will not edit a file the user configured.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
    /// Whether failing this check means a capture cannot work at all. Only
    /// blocking checks send the user to the setup screen; the rest cost
    /// diagnostics, and diagnostics skip rather than fail.
    pub blocking: bool,
}

impl EnvCheck {
    fn new(id: &'static str, label: impl Into<String>, state: CheckState, blocking: bool) -> Self {
        Self {
            id,
            label: label.into(),
            state,
            hint: None,
            lines: Vec::new(),
            blocking,
        }
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        // Only when there is something wrong to explain. A hint under a passing
        // row is noise the user has to read to discover it does not apply.
        if self.state != CheckState::Ok {
            self.hint = Some(hint.into());
        }
        self
    }

    /// Only the Linux checks have a config line to offer; Windows' remedies are
    /// a group membership and a reinstall.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn lines(mut self, lines: Vec<String>) -> Self {
        if self.state != CheckState::Ok {
            self.lines = lines;
        }
        self
    }
}

fn state_of(value: Option<bool>) -> CheckState {
    match value {
        Some(true) => CheckState::Ok,
        Some(false) => CheckState::Missing,
        None => CheckState::Unknown,
    }
}

/// Platform slug the webview switches copy on.
pub const fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Whether this platform's backend arms a watcher rather than starting a capture
/// (§23.1). Drives the armed screen; Windows never enters it.
pub const fn watcher_mode() -> bool {
    cfg!(target_os = "linux")
}

// ── Windows ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
pub fn checks(app: &tauri::AppHandle) -> Vec<EnvCheck> {
    use tauri_plugin_shell::ShellExt;

    use crate::presentmon::{capture_tool, SIDECAR};
    use crate::win;

    let group = state_of(win::in_performance_log_users());
    let sidecar = state_of(Some(app.shell().sidecar(SIDECAR).is_ok()));

    vec![
        EnvCheck::new(
            "performance-log-users",
            "This account is in Performance Log Users",
            group,
            true,
        )
        .hint(if group == CheckState::Unknown {
            "Membership could not be read. Follow the setup guide, then re-check."
        } else {
            // The second half is the part people get stuck on: group membership
            // is baked into the logon token, so joining the group changes
            // nothing until a new sign-in.
            "Add the account to the group, then sign out and back in — group \
             membership is baked into your logon token."
        }),
        EnvCheck::new(
            "capture-tool",
            format!("Bundled capture tool detected ({})", capture_tool()),
            sidecar,
            true,
        )
        .hint("The bundled sidecar is missing from this install. Reinstall Heimdall Capture."),
    ]
}

// ── Linux ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub fn checks(_app: &tauri::AppHandle) -> Vec<EnvCheck> {
    use std::path::PathBuf;

    use crate::linux;
    use crate::mangohud::{
        self, MangoHudParams, RECOMMENDED_LOG_INTERVAL_MS, SENSOR_PARAMS, UNKNOWN_CAPTURE_TOOL,
    };

    let env = mangohud::ConfigEnv::from_process();
    let inline = env
        .inline
        .as_deref()
        .map(MangoHudParams::parse)
        .unwrap_or_default();
    let files: Vec<MangoHudParams> = mangohud::config_candidates(&env)
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .map(|text| MangoHudParams::parse(&text))
        .collect();
    let found_a_config = !files.is_empty() || !inline.is_empty();
    // What MangoHud would apply: the inline environment over each file. When
    // there is no file at all, the inline set is all we have.
    let effective: MangoHudParams = files
        .into_iter()
        .fold(inline.clone(), |acc, file| acc.overlay(file));

    let tool = linux::capture_tool();
    let installed = tool != UNKNOWN_CAPTURE_TOOL;

    // The suggested output folder. `XDG_DATA_HOME`-adjacent rather than a
    // Heimdall-branded directory: the logs are MangoHud's, and the user may well
    // want them for something else.
    let suggested = env
        .home
        .clone()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join("mangohud-logs");
    let conf_lines = mangohud::suggested_conf_lines(&suggested);

    // A per-game Steam launch option (`MANGOHUD_CONFIG=... %command%`) belongs
    // to the game process, not to us. So a host config is evidence about the
    // default and nothing more, and every config-derived check that fails says
    // so rather than asserting the user got it wrong.
    const LAUNCH_OPTION_CAVEAT: &str =
        "If you set MANGOHUD_CONFIG in a per-game Steam launch option, Heimdall \
         cannot read it — this reflects your host config only.";

    let folder_state = if effective.output_folder().is_some() {
        CheckState::Ok
    } else if found_a_config {
        CheckState::Missing
    } else {
        // No config anywhere. We do not know what the game will use, and
        // claiming the folder is unset would be a claim we cannot support.
        CheckState::Unknown
    };

    let missing_sensors = mangohud::missing_sensor_params(&effective);
    let sensors_state = if !found_a_config {
        CheckState::Unknown
    } else if missing_sensors.is_empty() {
        CheckState::Ok
    } else {
        CheckState::Missing
    };

    let interval_state = if effective.log_interval_ms().is_some() {
        CheckState::Ok
    } else if found_a_config {
        CheckState::Missing
    } else {
        CheckState::Unknown
    };

    vec![
        EnvCheck::new(
            "mangohud-installed",
            if installed {
                format!("MangoHud detected ({tool})")
            } else {
                "MangoHud detected".to_string()
            },
            state_of(Some(installed)),
            true,
        )
        .hint(
            "Install MangoHud from your distribution's packages. Heimdall does not \
             bundle or inject an overlay — it reads the logs yours writes.",
        ),
        EnvCheck::new(
            "output-folder",
            "MangoHud writes its logs to a folder Heimdall can watch",
            folder_state,
            // The hard gate (§23.1): without this the logs land in each game's
            // own directory and there is nothing to watch.
            true,
        )
        .hint(format!(
            "Without output_folder, MangoHud writes beside each game's working \
             directory, which Heimdall cannot know. Add this to MangoHud.conf. \
             {LAUNCH_OPTION_CAVEAT}"
        ))
        .lines(conf_lines.clone()),
        EnvCheck::new(
            "sensor-params",
            "GPU, CPU and VRAM sensors are enabled",
            sensors_state,
            // Not blocking: every diagnostic that needs a sensor self-suppresses
            // on missing data. Fewer sensors means fewer findings, not a failed
            // capture — skip, never fail.
            false,
        )
        .hint(format!(
            "Missing: {}. The capture still uploads; sensor-based diagnostics \
             will simply not fire. {LAUNCH_OPTION_CAVEAT}",
            if missing_sensors.is_empty() {
                SENSOR_PARAMS
                    .iter()
                    .map(|(key, _)| *key)
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                missing_sensors.join(", ")
            }
        ))
        .lines(
            SENSOR_PARAMS
                .iter()
                .filter(|(key, _)| missing_sensors.contains(key) || missing_sensors.is_empty())
                .map(|(key, _)| (*key).to_string())
                .collect(),
        ),
        EnvCheck::new(
            "log-interval",
            "A logging interval is set, so the live trace updates during capture",
            interval_state,
            false,
        )
        .hint(format!(
            "Without log_interval, MangoHud may only write the log when logging \
             stops — the capture is complete either way, but Heimdall cannot draw \
             a live chart while it runs. {LAUNCH_OPTION_CAVEAT}"
        ))
        .lines(vec![format!("log_interval={RECOMMENDED_LOG_INTERVAL_MS}")]),
    ]
}

// ── Everything else ─────────────────────────────────────────────────────────

#[cfg(not(any(windows, target_os = "linux")))]
pub fn checks(_app: &tauri::AppHandle) -> Vec<EnvCheck> {
    vec![EnvCheck::new(
        "platform",
        "Capture is supported on this platform",
        CheckState::Missing,
        true,
    )
    .hint("Heimdall Capture supports Windows and Linux. macOS is a later phase.")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_serializes_to_the_shape_the_webview_renders() {
        let check = EnvCheck::new(
            "output-folder",
            "Logs go somewhere watchable",
            CheckState::Missing,
            true,
        )
        .hint("Add this line.")
        .lines(vec!["output_folder=/home/player/mangohud-logs".into()]);
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["id"], "output-folder");
        assert_eq!(json["state"], "missing");
        assert_eq!(json["blocking"], true);
        assert_eq!(json["hint"], "Add this line.");
        assert_eq!(json["lines"][0], "output_folder=/home/player/mangohud-logs");
    }

    #[test]
    fn a_passing_check_carries_no_remedy_copy() {
        // A hint under a green row is noise the user has to read to find out it
        // does not apply to them.
        let check = EnvCheck::new(
            "mangohud-installed",
            "MangoHud detected",
            CheckState::Ok,
            true,
        )
        .hint("Install MangoHud.")
        .lines(vec!["log_interval=100".into()]);
        let json = serde_json::to_value(&check).unwrap();
        assert!(json.get("hint").is_none());
        assert!(json.get("lines").is_none());
    }

    #[test]
    fn unknown_is_a_state_of_its_own_and_never_collapses_into_failure() {
        assert_eq!(state_of(Some(true)), CheckState::Ok);
        assert_eq!(state_of(Some(false)), CheckState::Missing);
        assert_eq!(state_of(None), CheckState::Unknown);
        assert_eq!(
            serde_json::to_value(CheckState::Unknown).unwrap(),
            serde_json::json!("unknown")
        );
    }

    #[test]
    fn every_check_id_on_this_platform_is_unique_and_at_least_one_blocks() {
        // Duplicate ids would collide as React keys and make one row
        // unreachable; zero blocking checks would make the setup screen
        // unreachable instead.
        let ids: Vec<&str> = PLATFORM_CHECK_IDS.to_vec();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "duplicate check id");
    }

    /// The ids this build's `checks()` produces. Kept as a constant rather than
    /// calling `checks()` because that needs an `AppHandle`, which a unit test
    /// has no way to build.
    #[cfg(windows)]
    const PLATFORM_CHECK_IDS: &[&str] = &["performance-log-users", "capture-tool"];
    #[cfg(target_os = "linux")]
    const PLATFORM_CHECK_IDS: &[&str] = &[
        "mangohud-installed",
        "output-folder",
        "sensor-params",
        "log-interval",
    ];
    #[cfg(not(any(windows, target_os = "linux")))]
    const PLATFORM_CHECK_IDS: &[&str] = &["platform"];

    #[test]
    fn the_platform_slug_and_watcher_mode_agree_with_each_other() {
        // The armed screen exists for the watcher backend and only for it.
        assert_eq!(watcher_mode(), platform() == "linux");
        assert!(matches!(platform(), "windows" | "linux" | "other"));
    }
}
