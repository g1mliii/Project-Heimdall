//! Bundled Intel PresentMon sidecar: argv, stdout framing, lifecycle (§21.2).
//!
//! The process itself is owned by `capture.rs`; everything decidable without a
//! live child lives here as a pure function so `cargo test` covers it against
//! fixture CSV rather than a real GPU.
//!
//! PresentMon is MIT-licensed and redistributed unmodified — see LICENSES.md
//! and docs/desktop-client.md for the pinned version and its provenance.

use serde::Serialize;

use crate::gpu_telemetry::{append_telemetry_cells, GpuTelemetry, TELEMETRY_HEADERS};

/// Sidecar base name declared in tauri.conf.json `bundle.externalBin`. Tauri
/// resolves it to `binaries/presentmon-x86_64-pc-windows-msvc.exe` at build
/// time and to the installed path at runtime.
pub const SIDECAR: &str = "binaries/presentmon";

/// Pinned upstream release. Recorded verbatim as the capture provenance
/// `captureTool` (§2.2) and asserted by scripts/fetch-presentmon.mjs, which is
/// the single source of truth for which build ships.
pub const PRESENTMON_VERSION: &str = "2.4.1";

/// `captureTool` string for the methodology manifest (§2.2).
pub fn capture_tool() -> String {
    format!("PresentMon {PRESENTMON_VERSION}")
}

/// Everything the UI needs to describe a running capture target.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureTarget {
    pub pid: u32,
    /// Executable name, e.g. `Cyberpunk2077.exe`.
    pub process: String,
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

/// Accumulates sidecar stdout into whole CSV lines.
///
/// Two jobs. It re-frames arbitrary chunk boundaries into lines for the live
/// event stream, and it retains the complete capture so that on stop the
/// webview gets one CSV buffer to hand to `parseAnyCapture` — the same bytes
/// the web upload path would have read from a file.
///
/// The retained buffer is capped: a capture left running overnight must fail
/// loudly at a known limit rather than exhaust memory.
#[derive(Debug)]
pub struct CaptureBuffer {
    pending: String,
    csv: String,
    frames: usize,
    bytes: usize,
    max_bytes: usize,
    overflowed: bool,
    /// Whether GPU-telemetry columns are being appended (§22.2). Off when the
    /// performance counters could not be opened — the columns are then omitted
    /// entirely rather than added and left permanently blank, which would only
    /// produce a `missing-sensors` warning on every capture.
    telemetry: bool,
}

/// Must match `INGEST_LIMITS.maxCaptureBytes` in @heimdall/shared. Keeping a
/// larger native buffer only delays an inevitable JavaScript-side rejection
/// while multiplying the peak across UTF-8, IPC, parser objects and Parquet.
pub const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;

impl Default for CaptureBuffer {
    fn default() -> Self {
        Self::with_limit(MAX_CAPTURE_BYTES)
    }
}

impl CaptureBuffer {
    pub fn with_limit(max_bytes: usize) -> Self {
        Self {
            pending: String::new(),
            csv: String::new(),
            frames: 0,
            bytes: 0,
            max_bytes,
            overflowed: false,
            telemetry: false,
        }
    }

    /// Append Heimdall's polled GPU columns to every row (§22.2).
    pub fn with_telemetry(mut self) -> Self {
        self.telemetry = true;
        self
    }

    /// Feed one stdout chunk with no telemetry attached.
    ///
    /// Test-only: production always goes through `push_with_telemetry`, which
    /// carries the most recent counter sample.
    #[cfg(test)]
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.push_with_telemetry(chunk, None)
    }

    /// Feed one stdout chunk. Returns the lines completed by this chunk, in
    /// order, for the live event stream.
    ///
    /// `sample` is the most recent counter reading; every row completed by this
    /// chunk carries it. Rows arriving before the first sample get empty cells,
    /// which the parser reads as "no reading" rather than as zero.
    pub fn push_with_telemetry(
        &mut self,
        chunk: &str,
        sample: Option<GpuTelemetry>,
    ) -> Vec<String> {
        if self.overflowed {
            return Vec::new();
        }
        self.pending.push_str(chunk);
        let Some(last_newline) = self.pending.rfind('\n') else {
            return Vec::new();
        };
        // Detach all complete rows once. Draining from the front for every row
        // repeatedly shifted the remainder of a large stdout chunk and made
        // row framing quadratic in that chunk's size.
        let remainder = self.pending.split_off(last_newline + 1);
        let complete = std::mem::replace(&mut self.pending, remainder);
        let mut completed = Vec::new();
        for raw_line in complete.split_terminator('\n') {
            let mut line = raw_line.to_string();
            // PresentMon on Windows emits CRLF; the parser tolerates it, but
            // the live stream should carry clean rows.
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            if self.telemetry {
                // The first line out of the sidecar is the header.
                if self.csv.is_empty() {
                    for header in TELEMETRY_HEADERS {
                        line.push(',');
                        line.push_str(header);
                    }
                } else {
                    append_telemetry_cells(&mut line, sample);
                }
            }
            let next_bytes = self.bytes.saturating_add(line.len() + 1);
            if next_bytes > self.max_bytes {
                self.overflowed = true;
                self.pending.clear();
                return completed;
            }
            let is_header = self.csv.is_empty();
            self.csv.push_str(&line);
            self.csv.push('\n');
            self.bytes = next_bytes;
            if !is_header {
                self.frames += 1;
            }
            completed.push(line);
        }
        completed
    }

    /// True once the retained capture passed its cap; the session is aborted
    /// rather than silently truncated.
    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    /// Frame rows: everything after the header line.
    pub fn frame_count(&self) -> usize {
        self.frames
    }

    /// The complete capture as the CSV bytes `parseAnyCapture` expects.
    ///
    /// A trailing partial line is dropped: a half-written row would fail the
    /// parse for the sake of one frame. Direct stdout is UTF-8 — the parser's
    /// UTF-16LE BOM sniffing exists for PowerShell redirection, which this
    /// path deliberately avoids.
    pub fn csv(&self) -> &str {
        &self.csv
    }

    /// Move the retained CSV out without allocating a second full-size copy.
    pub fn into_csv(self) -> String {
        self.csv
    }
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

    const FIXTURE: &str = "Application,ProcessID,FrameTime\ngame.exe,4242,10.1\ngame.exe,4242,9.8\ngame.exe,4242,10.4\n";

    #[test]
    fn reassembles_lines_across_arbitrary_chunk_boundaries() {
        for chunk_size in 1..=FIXTURE.len() {
            let mut buffer = CaptureBuffer::default();
            let mut streamed = Vec::new();
            let bytes = FIXTURE.as_bytes();
            for chunk in bytes.chunks(chunk_size) {
                streamed.extend(buffer.push(std::str::from_utf8(chunk).unwrap()));
            }
            assert_eq!(buffer.csv(), FIXTURE, "chunk size {chunk_size}");
            assert_eq!(streamed.len(), 4, "chunk size {chunk_size}");
            assert_eq!(buffer.frame_count(), 3);
        }
    }

    #[test]
    fn strips_crlf_and_drops_a_trailing_partial_row() {
        let mut buffer = CaptureBuffer::default();
        buffer.push("Application,FrameTime\r\ngame.exe,10.1\r\ngame.exe,9.");
        assert_eq!(buffer.csv(), "Application,FrameTime\ngame.exe,10.1\n");
        assert_eq!(buffer.frame_count(), 1);
    }

    #[test]
    fn appends_telemetry_columns_to_the_header_and_every_row() {
        let mut buffer = CaptureBuffer::default().with_telemetry();
        buffer.push_with_telemetry(
            "Application,FrameTime
",
            None,
        );
        buffer.push_with_telemetry(
            "game.exe,10
",
            Some(GpuTelemetry {
                gpu_load_pct: Some(97.5),
                vram_used_mb: Some(8192.0),
            }),
        );

        assert_eq!(
            buffer.csv(),
            concat!(
                "Application,FrameTime,HeimdallGpuUtilization,HeimdallGpuMemUsedMb
",
                "game.exe,10,97.5,8192.0
",
            )
        );
    }

    #[test]
    fn a_row_before_the_first_sample_gets_empty_cells_not_zeroes() {
        let mut buffer = CaptureBuffer::default().with_telemetry();
        buffer.push_with_telemetry(
            "Application,FrameTime
game.exe,10
",
            None,
        );
        // The parser reads an empty cell as "no reading". A literal 0 would say
        // the GPU was idle, which is a different and false claim.
        assert!(buffer.csv().ends_with(
            "game.exe,10,,
"
        ));
    }

    #[test]
    fn without_counters_no_telemetry_columns_are_added_at_all() {
        // A header promising columns that stay blank for the whole capture
        // would only earn a `missing-sensors` warning on every run.
        let mut buffer = CaptureBuffer::default();
        buffer.push(
            "Application,FrameTime
game.exe,10
",
        );
        assert_eq!(
            buffer.csv(),
            "Application,FrameTime
game.exe,10
"
        );
    }

    #[test]
    fn a_forgotten_session_trips_the_cap_instead_of_growing_without_bound() {
        let mut buffer = CaptureBuffer::with_limit(64);
        for _ in 0..100 {
            buffer.push("game.exe,4242,10.1\n");
        }
        assert!(buffer.overflowed());
        assert!(buffer.csv().len() <= 64);
    }
}
