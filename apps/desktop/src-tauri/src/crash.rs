//! Opt-in crash reporting (§22.7).
//!
//! DECISION: no crash-reporting SDK. A Rust panic hook writes one plain-text
//! log to the app's local data directory; on next launch the UI offers "Send
//! crash report", which opens a PREFILLED GitHub issue in the browser. The user
//! reads the text and presses submit, or does not.
//!
//! That is opt-in by construction — nothing leaves the machine unless a human
//! sends it — and it adds no dependency, no minimum-age soak, and no
//! privacy-policy change beyond naming the local file. An aggregating service
//! (Sentry) is the alternative if per-crash telemetry is ever wanted; it is a
//! separate decision with real privacy weight, so it is not the default.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const CRASH_FILE: &str = "last-crash.log";
const ISSUE_URL: &str = "https://github.com/g1mliii/Project-Heimdall/issues/new";

fn crash_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(CRASH_FILE))
}

/// Install the panic hook. Called once at startup, before anything can panic.
pub fn install(app: &AppHandle) {
    let Some(path) = crash_path(app) else { return };
    let version = app.package_info().version.to_string();
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        // No capture data, no hardware, no paths beyond the source location:
        // the report is deliberately thin enough to read in full before sending.
        let report = format!(
            "Heimdall Capture {version}\nos: {}\nlocation: {location}\npanic: {}\n",
            std::env::consts::OS,
            info.payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".into()),
        );
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&path, report);
        previous(info);
    }));
}

/// The pending report, if the previous run panicked.
pub fn pending_report(app: &AppHandle) -> Option<String> {
    let text = fs::read_to_string(crash_path(app)?).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

pub fn clear(app: &AppHandle) {
    if let Some(path) = crash_path(app) {
        let _ = fs::remove_file(path);
    }
}

/// Prefilled GitHub issue URL. The user sees the body in their browser before
/// anything is submitted.
pub fn issue_url(report: &str) -> String {
    // GitHub truncates very long query strings; the report is a handful of
    // lines by construction, but bound it anyway.
    let body: String = report.chars().take(4000).collect();
    format!(
        "{ISSUE_URL}?title={}&body={}",
        percent_encode("Desktop client crash"),
        percent_encode(&format!("```\n{body}\n```\n\nWhat were you doing?\n"))
    )
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_issue_url_is_prefilled_and_fully_escaped() {
        let url = issue_url("panic: index out of bounds\nlocation: src/x.rs:1:1");
        assert!(url.starts_with(ISSUE_URL));
        assert!(url.contains("title=Desktop%20client%20crash"));
        // Nothing may escape the query string unencoded.
        assert!(!url.contains('\n'));
        assert!(!url[ISSUE_URL.len()..].contains('#'));
    }

    #[test]
    fn a_long_report_is_bounded_rather_than_producing_an_unopenable_url() {
        let url = issue_url(&"x".repeat(100_000));
        assert!(url.len() < 20_000);
    }
}
