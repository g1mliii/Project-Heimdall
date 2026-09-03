//! Bundled Intel PresentMon sidecar: argv and provenance (§21.2).
//!
//! The process itself is owned by `capture.rs` and the row framing lives in
//! `stream.rs` (it is source-neutral — the Linux watcher uses the same buffer).
//! What remains here is everything specific to *this tool*, as pure functions,
//! so `cargo test` covers it without a real GPU.
//!
//! Windows-only by construction: the sidecar is a Win32 binary and
//! `bundle.externalBin` only names it in tauri.windows.conf.json (§24.1).
//!
//! PresentMon is MIT-licensed and redistributed unmodified — see LICENSES.md
//! and docs/desktop-client.md for the pinned version and its provenance.

use crate::stream::CaptureTarget;

/// Sidecar base name declared in tauri.windows.conf.json `bundle.externalBin`.
/// Tauri resolves it to `binaries/presentmon-x86_64-pc-windows-msvc.exe` at
/// build time and to the installed path at runtime.
pub const SIDECAR: &str = "binaries/presentmon";

/// Pinned upstream release. Recorded verbatim as the capture provenance
/// `captureTool` (§2.2) and asserted by scripts/fetch-presentmon.mjs, which is
/// the single source of truth for which build ships.
pub const PRESENTMON_VERSION: &str = "2.4.1";

/// `captureTool` string for the methodology manifest (§2.2).
pub fn capture_tool() -> String {
    format!("PresentMon {PRESENTMON_VERSION}")
}

/// Build the sidecar argv for a capture scoped to one process.
///
/// These flag names were read off `PresentMon-2.4.1-x64.exe --help`, not from
/// memory: PresentMon has renamed and inverted flags across releases (2.4 has
/// no `--track_gpu` — GPU work is tracked by default and `--no_track_gpu`
/// turns it OFF). If `PRESENTMON_VERSION` moves, re-read `--help` for that
/// build and update this function; it is deliberately the only place argv is
/// constructed so a version bump has exactly one edit site.
///
/// * `--process_id` scopes the trace to the foreground game, which is what
///   keeps the parser's multiple-streams path from firing (§22.1).
/// * `--output_stdout` streams CSV rows instead of writing a file, so raw
///   captures never touch disk.
/// * `--no_console_stats` suppresses the live swap-chain table, which would
///   otherwise interleave with the CSV on the same stream.
/// * `--v2_metrics` pins the column set explicitly instead of inheriting
///   whatever a future build defaults to — the parser's column contract and
///   the sensor-availability matrix are written against v2.
/// * `--stop_existing_session` makes a relaunch after a hard kill recoverable
///   instead of failing on a leftover ETW session.
/// * `--terminate_on_proc_exit` ends the capture when the game closes, so a
///   crashed game cannot leave the sidecar running.
/// * `--track_frame_type` adds the `FrameType` column. Kept because it costs
///   nothing, but do NOT expect it to identify generated frames on AMD: the
///   flag's own help says it "requires application and/or driver
///   instrumentation using Intel-PresentMon provider", and AMD's driver does
///   not emit that provider. Verified on an RX 9070 XT running Cyberpunk 2077
///   with FSR and frame generation enabled — 14,241 rows, every one labelled
///   `Application`. See docs/desktop-client.md for what that means for
///   `generatedFramePct`.
///
/// GPU telemetry columns (GPUUtilization / GPUFrequency / GPUPower /
/// GPUMemUsed) are NOT available to this sidecar, and no flag turns them on.
/// Verified empirically against PresentMon 2.4.1 on Windows 11 / RX 9070 XT:
/// the standalone CLI emits
///
///   Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,
///   PresentFlags,AllowsTearing,PresentMode,FrameType,CPUStartTime,FrameTime,
///   CPUBusy,CPUWait,GPULatency,GPUTime,GPUBusy,GPUWait,DisplayLatency,
///   DisplayedTime,AnimationError,AnimationTime,MsFlipDelay,
///   AllInputToPhotonLatency,ClickToPhotonLatency
///
/// and nothing more. Re-tested with Intel's full MSI installed and
/// `PresentMonSharedService` running: the header is byte-identical, for BOTH
/// the bundled 2.4.1 console CLI and Intel's own 2.5.1 console CLI, and
/// `--help` on 2.5.1 offers no telemetry switch that 2.4.1 lacks. The columns
/// belong to the PresentMon UI application, not the console tool — so no
/// amount of installing, elevating or flag-hunting reaches them from here.
///
/// This is therefore a hard capability boundary, not a trade we chose: the
/// sensors are simply absent, the capability manifest reports them absent, and
/// every diagnostic that needs them self-suppresses. Skip, never fail.
pub fn sidecar_args(target: &CaptureTarget) -> Vec<String> {
    vec![
        "--process_id".into(),
        target.pid.to_string(),
        "--output_stdout".into(),
        "--no_console_stats".into(),
        "--v2_metrics".into(),
        "--stop_existing_session".into(),
        "--terminate_on_proc_exit".into(),
        "--track_frame_type".into(),
    ]
}
#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> CaptureTarget {
        CaptureTarget {
            pid: 4242,
            process: "Cyberpunk2077.exe".into(),
        }
    }

    #[test]
    fn argv_scopes_the_trace_to_one_pid_and_streams_to_stdout() {
        let args = sidecar_args(&target());
        let pid_at = args.iter().position(|a| a == "--process_id").unwrap();
        assert_eq!(args[pid_at + 1], "4242");
        assert!(args.iter().any(|a| a == "--output_stdout"));
        // The console swap-chain table would interleave with the CSV.
        assert!(args.iter().any(|a| a == "--no_console_stats"));
        // Generated-frame evidence: without this the FrameType column is never
        // emitted and `generatedFramePct` can only ever be 0.
        assert!(args.iter().any(|a| a == "--track_frame_type"));
        // 2.4 tracks GPU work by default; passing a --track_gpu that no longer
        // exists would make the sidecar exit with a usage error.
        assert!(!args.iter().any(|a| a.starts_with("--track_gpu")));
        // A leftover ETW session from a hard kill must not brick the next run.
        assert!(args.iter().any(|a| a == "--stop_existing_session"));
        // No --output_file: raw captures never touch disk.
        assert!(!args.iter().any(|a| a.starts_with("--output_file")));
    }

    #[test]
    fn capture_tool_records_the_pinned_version_for_provenance() {
        assert_eq!(capture_tool(), format!("PresentMon {PRESENTMON_VERSION}"));
    }
}
