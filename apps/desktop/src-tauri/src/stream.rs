//! Source-neutral capture accumulation (§21.2, §22.1).
//!
//! Moved out of `presentmon.rs` in Phase 9.5: the framing rules here have
//! nothing to do with PresentMon. They are about turning *arbitrary byte chunks*
//! into whole CSV rows and retaining the result under a cap, which is exactly
//! what both capture backends need — the Windows sidecar's stdout pipe and the
//! Linux MangoHud watcher's tail reads go through the same `push`.
//!
//! Keeping one buffer for both is the point: line framing, CRLF stripping, the
//! trailing-partial-row rule and the retained-size cap are behaviours the parse
//! depends on, and a second implementation for the watcher would be a second
//! place for them to drift.

use serde::Serialize;

use crate::gpu_telemetry::{append_telemetry_cells, GpuTelemetry, TELEMETRY_HEADERS};

/// Everything the UI needs to describe a running capture target.
///
/// `pid` is 0 on backends that cannot name a process — the Linux watcher sees a
/// log file, not a game. 0 is never a real pid, so the UI can tell the two
/// apart without a second nullable field.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureTarget {
    pub pid: u32,
    /// Executable name, e.g. `Cyberpunk2077.exe`. On Linux this is whatever
    /// MangoHud named the log after, which is usually the game's binary.
    pub process: String,
}

/// Accumulates capture bytes into whole CSV lines.
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
    /// Retained rows, preamble and header included. Kept as a counter rather
    /// than derived from `csv`: counting newlines in a 64 MiB buffer once per
    /// row would make retention quadratic in the capture length.
    rows: usize,
    frames: usize,
    bytes: usize,
    max_bytes: usize,
    overflowed: bool,
    /// Whether GPU-telemetry columns are being appended (§22.2). Off when the
    /// performance counters could not be opened — the columns are then omitted
    /// entirely rather than added and left permanently blank, which would only
    /// produce a `missing-sensors` warning on every capture. Always off on
    /// Linux: MangoHud logs its own GPU columns.
    telemetry: bool,
    /// Rows consumed before the frame header was reached. MangoHud logs open
    /// with a sysinfo key row and its value row (§23.1); those are part of the
    /// file the parser reads, but they are not frames and must not be counted
    /// as such — the Complete screen's frame count has to match what
    /// `parseAnyCapture` finds.
    preamble_rows: usize,
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
            rows: 0,
            frames: 0,
            bytes: 0,
            max_bytes,
            overflowed: false,
            telemetry: false,
            preamble_rows: 0,
        }
    }

    /// Append Heimdall's polled GPU columns to every row (§22.2).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn with_telemetry(mut self) -> Self {
        self.telemetry = true;
        self
    }

    /// Declare how many leading rows are preamble rather than frames.
    ///
    /// Two for a MangoHud log (the sysinfo key row and its value row) so that
    /// the header row lands where the frame count starts, and zero for a
    /// PresentMon stream whose first row IS the header.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn with_preamble_rows(mut self, rows: usize) -> Self {
        self.preamble_rows = rows;
        self
    }

    /// Feed one chunk with no telemetry attached — the Linux watcher's tail
    /// reads, and the buffer's own unit tests.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.push_with_telemetry(chunk, None)
    }

    /// Feed one chunk. Returns the lines completed by this chunk, in order, for
    /// the live event stream.
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
        // repeatedly shifted the remainder of a large chunk and made row
        // framing quadratic in that chunk's size.
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
            // Row layout: `preamble_rows` preamble rows, then the header, then
            // frames. So the row at index `preamble_rows` is the header and
            // anything past it is a frame.
            let is_frame = self.rows > self.preamble_rows;
            self.csv.push_str(&line);
            self.csv.push('\n');
            self.bytes = next_bytes;
            self.rows += 1;
            if is_frame {
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

    /// Frame rows: everything after the preamble and the header line.
    pub fn frame_count(&self) -> usize {
        self.frames
    }

    /// Total bytes retained so far — the watcher's progress signal.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn retained_bytes(&self) -> usize {
        self.bytes
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
        buffer.push_with_telemetry("Application,FrameTime\n", None);
        buffer.push_with_telemetry(
            "game.exe,10\n",
            Some(GpuTelemetry {
                gpu_load_pct: Some(97.5),
                vram_used_mb: Some(8192.0),
            }),
        );

        assert_eq!(
            buffer.csv(),
            concat!(
                "Application,FrameTime,HeimdallGpuUtilization,HeimdallGpuMemUsedMb\n",
                "game.exe,10,97.5,8192.0\n",
            )
        );
    }

    #[test]
    fn a_row_before_the_first_sample_gets_empty_cells_not_zeroes() {
        let mut buffer = CaptureBuffer::default().with_telemetry();
        buffer.push_with_telemetry("Application,FrameTime\ngame.exe,10\n", None);
        // The parser reads an empty cell as "no reading". A literal 0 would say
        // the GPU was idle, which is a different and false claim.
        assert!(buffer.csv().ends_with("game.exe,10,,\n"));
    }

    #[test]
    fn without_counters_no_telemetry_columns_are_added_at_all() {
        // A header promising columns that stay blank for the whole capture
        // would only earn a `missing-sensors` warning on every run.
        let mut buffer = CaptureBuffer::default();
        buffer.push("Application,FrameTime\ngame.exe,10\n");
        assert_eq!(buffer.csv(), "Application,FrameTime\ngame.exe,10\n");
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

    // ── MangoHud preamble (§23.1) ───────────────────────────────────────────

    /// A MangoHud log's opening rows, in the order the file carries them.
    const MANGOHUD: &str = concat!(
        "os,cpu,gpu,ram,kernel,driver\n",
        "SteamOS 3.7.13,AMD Ryzen 7 9800X3D,AMD Radeon RX 9070 XT,32,6.11.11-valve,Mesa 26.1.4\n",
        "fps,frametime,cpu_load,gpu_load,elapsed\n",
        "144.7,6.91,42,97,16000000\n",
        "142.1,7.04,44,98,23000000\n",
    );

    #[test]
    fn mangohud_sysinfo_rows_are_not_counted_as_frames() {
        for chunk_size in 1..=MANGOHUD.len() {
            let mut buffer = CaptureBuffer::default().with_preamble_rows(2);
            for chunk in MANGOHUD.as_bytes().chunks(chunk_size) {
                buffer.push(std::str::from_utf8(chunk).unwrap());
            }
            // Five rows in the file; two sysinfo, one header, two frames. A
            // count of four here would put the Complete screen's number above
            // what `parseAnyCapture` reports for the same bytes.
            assert_eq!(buffer.frame_count(), 2, "chunk size {chunk_size}");
            assert_eq!(buffer.csv(), MANGOHUD, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn a_log_that_ends_inside_its_preamble_reports_no_frames() {
        let mut buffer = CaptureBuffer::default().with_preamble_rows(2);
        buffer.push("os,cpu,gpu\n");
        assert_eq!(buffer.frame_count(), 0);
        buffer.push("SteamOS,Ryzen,Radeon\n");
        assert_eq!(buffer.frame_count(), 0);
        buffer.push("fps,frametime\n");
        assert_eq!(buffer.frame_count(), 0);
        buffer.push("144.7,6.91\n");
        assert_eq!(buffer.frame_count(), 1);
    }
}
