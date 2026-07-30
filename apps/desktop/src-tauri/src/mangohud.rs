//! MangoHud config discovery and log selection (§23.1).
//!
//! ── Why a watcher and not a launcher ────────────────────────────────────────
//!
//! Heimdall does not inject an overlay on Linux. MangoHud is the user's: they
//! installed it, they configured it, and they start and stop its logging with
//! its own hotkey. So the Linux capture backend *watches for a log* rather than
//! starting a tool. That is a deliberate product decision, not a limitation we
//! are working around — a second overlay injected into a game the user already
//! has MangoHud in would be worse for them and less honest about provenance.
//!
//! It has one consequence worth stating plainly: the client cannot promise a
//! capture will start. It arms, and it reports what appears.
//!
//! ── Why everything here is pure ─────────────────────────────────────────────
//!
//! Nothing in this module touches the filesystem. Config text, path candidates,
//! log selection and the quiesce rule are all decided from values passed in, so
//! `cargo test` covers them on the Windows CI job too — the watcher's rules are
//! where the bugs would be, and they should not need a Linux runner to catch.
//! The thread that actually reads directories lives in `capture.rs`.
//!
//! ── The config we cannot see ────────────────────────────────────────────────
//!
//! MangoHud is very often configured per-game through a Steam launch option
//! (`MANGOHUD_CONFIG=... %command%`). That environment belongs to the game
//! process, not to us, so a host config file is evidence about the default and
//! nothing more. Every check derived from it says so in its own hint rather than
//! asserting the user got it wrong — see `env.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How long a log file's size must hold steady before the capture is treated as
/// finished. MangoHud writes in bursts, so this has to outlast a flush gap
/// without making the user wait on a Stop they already pressed.
pub const QUIESCE: Duration = Duration::from_millis(2500);

/// Directory scan cadence while armed. Polling rather than inotify on purpose:
/// no new crate, no per-user watch limits, and no Flatpak portal complications
/// for a cost that only exists between arm and stop.
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// MangoHud log rows before the frame header: the sysinfo key row and its value
/// row (§23.1). Declared to `CaptureBuffer::with_preamble_rows` so the live
/// frame count matches what `parseAnyCapture` reports for the same bytes.
pub const PREAMBLE_ROWS: usize = 2;

/// The `log_interval` we recommend, in milliseconds. Not enforced — a capture
/// with no interval set still uploads, it just may not draw a live trace.
pub const RECOMMENDED_LOG_INTERVAL_MS: u64 = 100;

// ── Config parsing ──────────────────────────────────────────────────────────

/// A MangoHud parameter set, whether it came from a file or from
/// `MANGOHUD_CONFIG`.
///
/// Values are stored verbatim; interpretation is per-accessor, because MangoHud
/// parameters are a mix of `key=value` and bare presence flags and conflating
/// the two would make `gpu_stats` (a flag) look unset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MangoHudParams {
    values: BTreeMap<String, String>,
}

impl MangoHudParams {
    /// Parse MangoHud's parameter syntax.
    ///
    /// Both forms are the same grammar with different separators, which is why
    /// this takes both: a config file separates parameters by newline, and
    /// `MANGOHUD_CONFIG` separates them by comma. Comments run from `#` to end
    /// of line, and whitespace around keys and values is insignificant.
    pub fn parse(text: &str) -> Self {
        let mut values = BTreeMap::new();
        for raw in text.split(['\n', '\r', ',']) {
            // A `#` starts a comment wherever it appears.
            let line = match raw.find('#') {
                Some(at) => &raw[..at],
                None => raw,
            }
            .trim();
            if line.is_empty() {
                continue;
            }
            let (key, value) = match line.split_once('=') {
                Some((key, value)) => (key.trim(), value.trim()),
                // A bare parameter is a flag: present, with no value.
                None => (line, ""),
            };
            if key.is_empty() {
                continue;
            }
            values.insert(key.to_ascii_lowercase(), value.to_string());
        }
        Self { values }
    }

    /// Layer `self` over `base`: every key `self` declares wins.
    ///
    /// `MANGOHUD_CONFIG` overrides the file per-parameter rather than replacing
    /// it wholesale, so a launch option that sets only `output_folder` must not
    /// erase the file's `log_interval`.
    pub fn overlay(self, base: Self) -> Self {
        let mut values = base.values;
        values.extend(self.values);
        Self { values }
    }

    /// Whether a parameter is present at all, with or without a value.
    pub fn has(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Where MangoHud writes its logs.
    ///
    /// `None` is the hard onboarding gate (§23.1): with no `output_folder`,
    /// MangoHud writes beside the game's working directory, which we cannot
    /// know. There is nothing to guess at — the checklist says so and prints
    /// the line to add.
    pub fn output_folder(&self) -> Option<PathBuf> {
        let raw = self.values.get("output_folder")?.trim();
        if raw.is_empty() {
            return None;
        }
        Some(PathBuf::from(expand_tilde(raw)))
    }

    /// `log_interval`, in milliseconds.
    ///
    /// Only a positive interval is reported. `log_interval=0` is MangoHud's
    /// "every frame" setting, which is a valid way to capture but not the
    /// periodic-flush behaviour the live trace wants, so it reads as unset here
    /// and the Capturing screen falls back to its honest "waiting to flush"
    /// copy rather than promising a sparkline.
    pub fn log_interval_ms(&self) -> Option<u64> {
        let parsed = self
            .values
            .get("log_interval")?
            .trim()
            .parse::<u64>()
            .ok()?;
        (parsed > 0).then_some(parsed)
    }
}

/// `~` and `$HOME` at the start of a path, against the supplied home directory.
///
/// MangoHud itself expands these, so a config that works for the user must work
/// for us; reading `~/mangologs` literally would look for a directory named
/// `~`.
fn expand_tilde(raw: &str) -> String {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return raw.to_string();
    };
    expand_tilde_with(raw, &home)
}

fn expand_tilde_with(raw: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("~/") {
        return format!("{home}/{rest}");
    }
    if raw == "~" {
        return home.into_owned();
    }
    if let Some(rest) = raw.strip_prefix("$HOME/") {
        return format!("{home}/{rest}");
    }
    if raw == "$HOME" {
        return home.into_owned();
    }
    raw.to_string()
}

// ── Config location ─────────────────────────────────────────────────────────

/// The environment values config discovery depends on, gathered in one place so
/// the resolution order is testable without setting process-wide variables.
#[derive(Debug, Clone, Default)]
pub struct ConfigEnv {
    /// `MANGOHUD_CONFIG` — inline `key=value,key=value`.
    pub inline: Option<String>,
    /// `MANGOHUD_CONFIGFILE` — an explicit config path, which MangoHud honours
    /// in preference to the XDG locations.
    pub config_file: Option<PathBuf>,
    /// `XDG_CONFIG_HOME`, if set.
    pub xdg_config_home: Option<PathBuf>,
    /// `$HOME`.
    pub home: Option<PathBuf>,
}

impl ConfigEnv {
    pub fn from_process() -> Self {
        Self {
            inline: std::env::var("MANGOHUD_CONFIG").ok(),
            config_file: std::env::var_os("MANGOHUD_CONFIGFILE").map(PathBuf::from),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
}

/// Config files to read, most-specific first. The first one that exists wins.
///
/// The Flatpak Steam entry is the one that is easy to miss and the most likely
/// first-run failure: a game launched from Flatpak Steam reads
/// `~/.var/app/com.valvesoftware.Steam/config/MangoHud/MangoHud.conf`, NOT the
/// host `~/.config` one, so a user whose host config is perfect can still see
/// no columns and no output folder.
pub fn config_candidates(env: &ConfigEnv) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = &env.config_file {
        candidates.push(explicit.clone());
    }
    let xdg = env
        .xdg_config_home
        .clone()
        .or_else(|| env.home.as_ref().map(|home| home.join(".config")));
    if let Some(xdg) = xdg {
        candidates.push(xdg.join("MangoHud").join("MangoHud.conf"));
    }
    if let Some(home) = &env.home {
        candidates.push(
            home.join(".var")
                .join("app")
                .join("com.valvesoftware.Steam")
                .join("config")
                .join("MangoHud")
                .join("MangoHud.conf"),
        );
    }
    candidates.push(PathBuf::from("/etc/MangoHud.conf"));
    candidates
}

/// Every directory the watcher should scan.
///
/// All of them, not just the first: a user with both a host Steam and a Flatpak
/// Steam has two configs that can name two different folders, and the watcher
/// has no way to know which one the game it is about to capture will read.
pub fn log_dir_candidates(configs: &[MangoHudParams]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for params in configs {
        if let Some(folder) = params.output_folder() {
            if !dirs.contains(&folder) {
                dirs.push(folder);
            }
        }
    }
    dirs
}

// ── Log identification ──────────────────────────────────────────────────────

/// Does this file head look like a MangoHud frame log?
///
/// Mirrors the `fps,frametime` header shape `packages/parsers/src/detect.ts`
/// sniffs for, deliberately: a file the watcher accepts and the parser then
/// rejects is the worst outcome available — the user captured, waited, and got
/// an "unrecognized format" at the end of it.
///
/// MangoHud logs open with a sysinfo key row and its value row, so the header
/// is not the first line and this scans rather than testing line 0.
pub fn looks_like_mangohud_log(head: &str) -> bool {
    head.lines().any(|line| {
        let lowered = line.trim().to_ascii_lowercase();
        let mut cells = lowered.split(',').map(str::trim);
        cells.next() == Some("fps") && cells.next() == Some("frametime")
    })
}

/// A MangoHud log file name → the process name for the `Game` row.
///
/// MangoHud names logs `<binary>_<YYYY-MM-DD>_<HH-MM-SS>.csv`. Stripping the
/// timestamp is worth doing: the value prefills the run's game name (§16c), and
/// `Cyberpunk2077_2026-07-29_18-04-11` in that field is something every user
/// would have to edit by hand on every upload.
///
/// The timestamp is only removed when it actually looks like one. A game whose
/// binary genuinely contains underscores keeps them.
pub fn process_from_log_name(file_name: &str) -> String {
    let stem = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name);
    let trimmed = strip_log_timestamp(stem);
    if trimmed.is_empty() {
        // A log named nothing but a timestamp still has to say something.
        stem.to_string()
    } else {
        trimmed.to_string()
    }
}

fn strip_log_timestamp(stem: &str) -> &str {
    // Two trailing `_`-separated segments: the date and the time.
    let is_date = |part: &str| {
        part.len() == 10
            && part.split('-').count() == 3
            && part.chars().all(|c| c.is_ascii_digit() || c == '-')
    };
    let is_time = |part: &str| {
        part.len() == 8
            && part.split('-').count() == 3
            && part.chars().all(|c| c.is_ascii_digit() || c == '-')
    };
    let Some((head, time)) = stem.rsplit_once('_') else {
        return stem;
    };
    if !is_time(time) {
        return stem;
    }
    match head.rsplit_once('_') {
        Some((head, date)) if is_date(date) => head,
        _ => stem,
    }
}

/// A candidate log file, reduced to what selection needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogCandidate {
    pub path: PathBuf,
    /// Last modification time as reported by the filesystem.
    pub modified: SystemTime,
    /// Whether the file's head passed [`looks_like_mangohud_log`].
    pub is_mangohud: bool,
}

/// Pick the capture from everything currently in the watched directories.
///
/// The newest MangoHud log modified at or after the arm instant. Both halves
/// matter:
///
/// * **after arm** is what stops a previous session's log from being uploaded
///   as this one. A user who has been benchmarking all week has a folder full
///   of valid MangoHud logs, and silently picking the wrong one would produce a
///   run that is entirely real and entirely not what they just captured.
/// * **is a MangoHud log** is what stops an unrelated CSV that happens to be
///   in the output folder from being taken as frame data.
pub fn select_log(candidates: &[LogCandidate], armed_at: SystemTime) -> Option<&LogCandidate> {
    candidates
        .iter()
        .filter(|candidate| candidate.is_mangohud && candidate.modified >= armed_at)
        .max_by_key(|candidate| candidate.modified)
}

/// Whether a file whose size has stopped changing should end the capture.
///
/// Size, not mtime: a filesystem with coarse timestamp granularity can report
/// an unchanged mtime for a file that is still being appended to, and ending a
/// live capture early is worse than waiting an extra poll.
pub fn has_quiesced(stable_for: Duration) -> bool {
    stable_for >= QUIESCE
}

// ── Provenance ──────────────────────────────────────────────────────────────

/// `mangohud --version` output → the `captureTool` string (§2.2).
///
/// Reported verbatim from the tool where possible. When MangoHud is not
/// installed or does not answer, this returns `None` and the caller records
/// `MangoHud (version unknown)` — the capture is still perfectly good, and a
/// fabricated version number in the provenance would be worse than an admitted
/// gap.
pub fn parse_version_output(output: &str) -> Option<String> {
    // Observed shapes are `MangoHud 0.8.1` and a bare `0.8.1`; both are handled
    // rather than pinning one, because this is provenance and a parse failure
    // here silently downgrades every Linux run's `captureTool`.
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    // A leading `v` is stripped so `v0.8.1` and `0.8.1` produce the same
    // provenance string — otherwise the same MangoHud build would label runs
    // two different ways depending on how it was packaged.
    let version = line
        .split_whitespace()
        .map(|token| token.strip_prefix('v').unwrap_or(token))
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()))?;
    Some(format!("MangoHud {version}"))
}

/// `captureTool` when the version could not be read.
pub const UNKNOWN_CAPTURE_TOOL: &str = "MangoHud (version unknown)";

// ── Onboarding checks ───────────────────────────────────────────────────────

/// The `.conf` lines a user needs, printed verbatim by the onboarding screen.
///
/// Shown, never written: Heimdall does not own `MangoHud.conf` and will not
/// edit a file the user configured. Telling them the exact line to add is the
/// whole fix and leaves them in control of their own overlay.
pub fn suggested_conf_lines(output_folder: &Path) -> Vec<String> {
    vec![
        format!("output_folder={}", output_folder.display()),
        format!("log_interval={RECOMMENDED_LOG_INTERVAL_MS}"),
    ]
}

/// MangoHud parameters that populate the sensor columns Heimdall's diagnostics
/// read (§7.3). Absent ones are not an error — every rule that needs a sensor
/// self-suppresses on missing data — so these are reported as "fewer
/// diagnostics", never as a failed capture.
pub const SENSOR_PARAMS: &[(&str, &str)] = &[
    ("gpu_stats", "GPU load, clock and power"),
    ("cpu_stats", "CPU load"),
    ("vram", "VRAM used"),
];

/// Sensor parameters this config does not enable.
pub fn missing_sensor_params(params: &MangoHudParams) -> Vec<&'static str> {
    SENSOR_PARAMS
        .iter()
        .filter(|(key, _)| !params.has(key))
        .map(|(key, _)| *key)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF: &str = "\
# MangoHud config
gpu_stats
cpu_stats
vram
  output_folder = /home/player/mangologs   # where logs land
log_interval=100
";

    #[test]
    fn parses_the_file_form_with_comments_flags_and_loose_whitespace() {
        let params = MangoHudParams::parse(CONF);
        assert_eq!(
            params.output_folder(),
            Some(PathBuf::from("/home/player/mangologs"))
        );
        assert_eq!(params.log_interval_ms(), Some(100));
        // Bare parameters are flags, and must not read as unset.
        assert!(params.has("gpu_stats"));
        assert!(params.has("cpu_stats"));
        assert!(params.has("vram"));
        assert!(!params.has("ram"));
        // A trailing comment is not part of the value.
        assert!(missing_sensor_params(&params).is_empty());
    }

    #[test]
    fn parses_the_inline_env_form() {
        let params = MangoHudParams::parse("gpu_stats,output_folder=/tmp/logs,log_interval=250");
        assert_eq!(params.output_folder(), Some(PathBuf::from("/tmp/logs")));
        assert_eq!(params.log_interval_ms(), Some(250));
        assert_eq!(missing_sensor_params(&params), vec!["cpu_stats", "vram"]);
    }

    #[test]
    fn keys_are_case_insensitive_like_mangohuds_own_parser() {
        let params = MangoHudParams::parse("OUTPUT_FOLDER=/tmp/logs,Log_Interval=100");
        assert_eq!(params.output_folder(), Some(PathBuf::from("/tmp/logs")));
        assert_eq!(params.log_interval_ms(), Some(100));
    }

    #[test]
    fn an_absent_output_folder_is_reported_as_absent_not_guessed_at() {
        // MangoHud would write beside the game's working directory, which the
        // client cannot know. This is the hard onboarding gate (§23.1).
        let params = MangoHudParams::parse("gpu_stats\nlog_interval=100\n");
        assert_eq!(params.output_folder(), None);
        // An empty value is the same as absent, not a path of "".
        assert_eq!(
            MangoHudParams::parse("output_folder=").output_folder(),
            None
        );
        assert_eq!(
            MangoHudParams::parse("output_folder=   ").output_folder(),
            None
        );
    }

    #[test]
    fn log_interval_zero_reads_as_unset_because_it_is_not_periodic() {
        // Valid MangoHud ("log every frame"), but it is not the periodic flush
        // the live trace needs, so the UI must not promise a sparkline.
        assert_eq!(
            MangoHudParams::parse("log_interval=0").log_interval_ms(),
            None
        );
        assert_eq!(
            MangoHudParams::parse("log_interval=nonsense").log_interval_ms(),
            None
        );
        assert_eq!(
            MangoHudParams::parse("log_interval").log_interval_ms(),
            None
        );
    }

    #[test]
    fn inline_config_overrides_the_file_per_parameter_not_wholesale() {
        let file = MangoHudParams::parse(CONF);
        let inline = MangoHudParams::parse("output_folder=/tmp/override");
        let merged = inline.overlay(file);
        assert_eq!(merged.output_folder(), Some(PathBuf::from("/tmp/override")));
        // A launch option that sets only the folder must not erase the interval.
        assert_eq!(merged.log_interval_ms(), Some(100));
        assert!(merged.has("gpu_stats"));
    }

    #[test]
    fn a_tilde_output_folder_expands_against_home() {
        assert_eq!(
            expand_tilde_with("~/mangologs", Path::new("/home/player")),
            "/home/player/mangologs"
        );
        assert_eq!(
            expand_tilde_with("$HOME/logs", Path::new("/home/player")),
            "/home/player/logs"
        );
        assert_eq!(
            expand_tilde_with("~", Path::new("/home/player")),
            "/home/player"
        );
        // Not a home-relative path: left exactly as written.
        assert_eq!(
            expand_tilde_with("/var/logs/~odd", Path::new("/home/player")),
            "/var/logs/~odd"
        );
    }

    #[test]
    fn config_resolution_prefers_explicit_then_xdg_then_flatpak_steam_then_etc() {
        let env = ConfigEnv {
            inline: None,
            config_file: Some(PathBuf::from("/explicit/MangoHud.conf")),
            xdg_config_home: Some(PathBuf::from("/home/player/.xdg")),
            home: Some(PathBuf::from("/home/player")),
        };
        assert_eq!(
            config_candidates(&env),
            vec![
                PathBuf::from("/explicit/MangoHud.conf"),
                PathBuf::from("/home/player/.xdg/MangoHud/MangoHud.conf"),
                PathBuf::from(
                    "/home/player/.var/app/com.valvesoftware.Steam/config/MangoHud/MangoHud.conf"
                ),
                PathBuf::from("/etc/MangoHud.conf"),
            ]
        );
    }

    #[test]
    fn without_xdg_config_home_the_default_config_dir_is_used() {
        let env = ConfigEnv {
            home: Some(PathBuf::from("/home/player")),
            ..ConfigEnv::default()
        };
        let candidates = config_candidates(&env);
        assert_eq!(
            candidates[0],
            PathBuf::from("/home/player/.config/MangoHud/MangoHud.conf")
        );
    }

    #[test]
    fn flatpak_steams_config_is_always_a_candidate() {
        // The most likely first-run failure: a game launched from Flatpak Steam
        // reads this file, not the host one, so a user with a perfect
        // ~/.config setup can still see nothing.
        let env = ConfigEnv {
            home: Some(PathBuf::from("/home/player")),
            ..ConfigEnv::default()
        };
        assert!(config_candidates(&env)
            .iter()
            .any(|path| path.to_string_lossy().contains("com.valvesoftware.Steam")));
    }

    #[test]
    fn every_configs_output_folder_is_watched_and_duplicates_collapse() {
        let host = MangoHudParams::parse("output_folder=/home/player/mangologs");
        let flatpak = MangoHudParams::parse("output_folder=/home/player/flatpak-logs");
        let same = MangoHudParams::parse("output_folder=/home/player/mangologs");
        let no_folder = MangoHudParams::parse("gpu_stats");
        assert_eq!(
            log_dir_candidates(&[host, flatpak, same, no_folder]),
            vec![
                PathBuf::from("/home/player/mangologs"),
                PathBuf::from("/home/player/flatpak-logs"),
            ]
        );
    }

    // ── Log identification ──────────────────────────────────────────────────

    const MANGOHUD_HEAD: &str = "\
os,cpu,gpu,ram,kernel,driver
SteamOS 3.7.13,AMD Ryzen 7 9800X3D,AMD Radeon RX 9070 XT,32,6.11.11-valve,Mesa 26.1.4
fps,frametime,cpu_load,gpu_load,elapsed
144.7,6.91,42,97,16000000
";

    #[test]
    fn recognizes_a_mangohud_log_whose_header_is_not_the_first_line() {
        assert!(looks_like_mangohud_log(MANGOHUD_HEAD));
    }

    #[test]
    fn rejects_csvs_that_are_not_mangohud_logs() {
        // A PresentMon capture that happens to be in the output folder.
        assert!(!looks_like_mangohud_log(
            "Application,ProcessID,FrameTime\ngame.exe,4242,10.1\n"
        ));
        // Something else entirely.
        assert!(!looks_like_mangohud_log("date,amount\n2026-07-29,12.50\n"));
        assert!(!looks_like_mangohud_log(""));
        // `fps` present but not the MangoHud header shape.
        assert!(!looks_like_mangohud_log("time,fps,frametime\n1,144,6.9\n"));
    }

    #[test]
    fn a_log_name_becomes_a_game_name_without_its_timestamp() {
        assert_eq!(
            process_from_log_name("Cyberpunk2077_2026-07-29_18-04-11.csv"),
            "Cyberpunk2077"
        );
        // A binary with its own underscores keeps them.
        assert_eq!(
            process_from_log_name("shadow_of_the_tomb_raider_2026-07-29_18-04-11.csv"),
            "shadow_of_the_tomb_raider"
        );
        // No timestamp to strip.
        assert_eq!(process_from_log_name("benchmark.csv"), "benchmark");
        assert_eq!(process_from_log_name("my_game.csv"), "my_game");
        // Only one of the two trailing segments looks like a timestamp.
        assert_eq!(process_from_log_name("game_18-04-11.csv"), "game_18-04-11");
        // Degenerate, but must still name something.
        assert_eq!(
            process_from_log_name("2026-07-29_18-04-11.csv"),
            "2026-07-29_18-04-11"
        );
    }

    fn candidate(path: &str, secs: u64, is_mangohud: bool) -> LogCandidate {
        LogCandidate {
            path: PathBuf::from(path),
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
            is_mangohud,
        }
    }

    #[test]
    fn selects_the_newest_log_modified_after_arming() {
        let armed = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let candidates = [
            candidate("/logs/old.csv", 900, true),
            candidate("/logs/this-one.csv", 1200, true),
            candidate("/logs/earlier-this-session.csv", 1050, true),
        ];
        assert_eq!(
            select_log(&candidates, armed).map(|c| c.path.clone()),
            Some(PathBuf::from("/logs/this-one.csv"))
        );
    }

    #[test]
    fn a_stale_log_from_a_previous_session_is_never_picked_up() {
        // A folder full of perfectly valid logs from last week must not become
        // this capture. The run would be real and entirely wrong.
        let armed = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let candidates = [
            candidate("/logs/monday.csv", 100, true),
            candidate("/logs/tuesday.csv", 200, true),
        ];
        assert!(select_log(&candidates, armed).is_none());
    }

    #[test]
    fn a_non_mangohud_csv_in_the_output_folder_is_not_taken_as_frame_data() {
        let armed = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let candidates = [
            candidate("/logs/spreadsheet.csv", 2000, false),
            candidate("/logs/real.csv", 1100, true),
        ];
        assert_eq!(
            select_log(&candidates, armed).map(|c| c.path.clone()),
            Some(PathBuf::from("/logs/real.csv"))
        );
    }

    #[test]
    fn a_log_modified_exactly_at_the_arm_instant_counts() {
        // Arming and MangoHud's first write can land in the same filesystem
        // timestamp tick; excluding the boundary would drop that capture.
        let armed = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let candidates = [candidate("/logs/edge.csv", 1000, true)];
        assert!(select_log(&candidates, armed).is_some());
    }

    // ── Quiesce ─────────────────────────────────────────────────────────────

    #[test]
    fn quiesce_waits_out_a_flush_gap_before_calling_the_capture_over() {
        assert!(!has_quiesced(Duration::from_millis(0)));
        assert!(!has_quiesced(QUIESCE - Duration::from_millis(1)));
        assert!(has_quiesced(QUIESCE));
        assert!(has_quiesced(QUIESCE + Duration::from_secs(10)));
        // A quiesce shorter than the poll interval could never be observed.
        assert!(QUIESCE > POLL_INTERVAL);
    }

    // ── Provenance ──────────────────────────────────────────────────────────

    #[test]
    fn version_output_becomes_the_capture_tool_string() {
        assert_eq!(
            parse_version_output("MangoHud 0.8.1").as_deref(),
            Some("MangoHud 0.8.1")
        );
        assert_eq!(
            parse_version_output("0.8.1\n").as_deref(),
            Some("MangoHud 0.8.1")
        );
        assert_eq!(
            parse_version_output("\nMangoHud v0.7.0-1-g1234\n").as_deref(),
            Some("MangoHud 0.7.0-1-g1234")
        );
    }

    #[test]
    fn an_unreadable_version_is_admitted_rather_than_invented() {
        assert_eq!(parse_version_output(""), None);
        assert_eq!(parse_version_output("command not found"), None);
        // The caller's fallback says so out loud.
        assert!(UNKNOWN_CAPTURE_TOOL.starts_with("MangoHud"));
        assert!(UNKNOWN_CAPTURE_TOOL.contains("unknown"));
    }

    #[test]
    fn suggested_lines_are_pasteable_conf_syntax() {
        let lines = suggested_conf_lines(Path::new("/home/player/mangologs"));
        assert_eq!(lines[0], "output_folder=/home/player/mangologs");
        assert_eq!(lines[1], "log_interval=100");
        // They must round-trip through our own parser, or the screen is telling
        // the user to write something we would then fail to read.
        let params = MangoHudParams::parse(&lines.join("\n"));
        assert_eq!(
            params.output_folder(),
            Some(PathBuf::from("/home/player/mangologs"))
        );
        assert_eq!(params.log_interval_ms(), Some(RECOMMENDED_LOG_INTERVAL_MS));
    }
}
