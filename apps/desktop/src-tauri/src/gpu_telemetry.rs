//! GPU utilization and VRAM from Windows performance counters (§22.2).
//!
//! ── Why not PresentMon ──────────────────────────────────────────────────────
//!
//! The bundled console application emits no GPU telemetry: confirmed against
//! 2.4.1 and 2.5.1, with and without Intel's service installed, and confirmed
//! again by Intel's own console-app README (its GPU metrics are all timing —
//! `MsGPULatency`/`MsGPUTime`/`MsGPUBusy`/`MsGPUWait`). Those columns belong to
//! the PresentMon UI application.
//!
//! Windows supplies the two that matter anyway, through PDH, with no elevation,
//! no vendor SDK and no extra install:
//!
//!   \GPU Engine(*)\Utilization Percentage   → per-process, per-engine load
//!   \GPU Process Memory(*)\Local Usage      → per-process VRAM, in bytes
//!
//! Instance names embed the owning pid, so readings are attributed to the
//! captured game rather than to whatever else is on the GPU.
//!
//! ── What this is NOT ────────────────────────────────────────────────────────
//!
//! These are POLLED on a timer, so a reading describes an interval, not the
//! frame it lands beside. The parser marks them `frameAligned: false` and the
//! per-frame `cpu-bottleneck` rule refuses them on that basis. That is correct
//! and deliberate — do not "fix" it by claiming alignment we do not have.
//!
//! GPU clock and power are NOT available here; PDH has no counters for them.
//! They need vendor SDKs (ADLX / NVML / IGCL) and are simply absent for now.

use serde::Serialize;

/// Counter sample handed to the capture stream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuTelemetry {
    /// Whole-GPU 3D load attributable to the captured process, 0–100.
    pub gpu_load_pct: Option<f64>,
    /// Dedicated video memory the captured process has resident, in MiB.
    pub vram_used_mb: Option<f64>,
}

/// How often the sampler polls. 200 ms is Task Manager's own cadence: fast
/// enough to track a scene change, slow enough that the counter query is not a
/// measurable share of the frame budget it is supposed to be observing.
pub const SAMPLE_INTERVAL_MS: u64 = 200;

// ── Pure aggregation ────────────────────────────────────────────────────────

/// Does this PDH instance name belong to `pid`?
///
/// Instances look like
/// `pid_6500_luid_0x00000000_0x030c6551_phys_0_eng_0_engtype_3d`. The trailing
/// underscore matters: without it `pid_650` would also match `pid_6500`.
fn instance_is_pid(instance: &str, pid: u32) -> bool {
    instance.starts_with(&format!("pid_{pid}_"))
}

/// Is this a 3D-engine instance?
///
/// Case-insensitive `contains`, not `ends_with`, and both halves of that are
/// load-bearing — verified against raw PDH output on Windows 11:
///
/// * PDH writes `engtype_3D` with a capital D. PowerShell's `Get-Counter`
///   lowercases instance names for display, so reading the shape off a console
///   session and matching it literally silently matches nothing.
/// * PDH appends a disambiguation index to duplicated instance names
///   (`..._engtype_Compute 0`), so a 3D instance can end in a digit rather than
///   in the engine type.
fn is_3d_engine(instance_lower: &str) -> bool {
    instance_lower.contains("engtype_3d")
}

/// `\GPU Engine(*)\Utilization Percentage` instances → the process's 3D load.
///
/// Only `engtype_3d` counts. A GPU also exposes copy, video-decode and
/// video-encode engines, and summing those into "GPU load" would report a
/// video-playing process as busier than it is on the engine that renders
/// frames.
///
/// Multiple 3D engine instances (multi-adapter, or a driver exposing several)
/// are summed and then clamped to 100. The clamp is load-bearing: the parser's
/// plausibility guard drops any percentage above 100 outright, so an unclamped
/// sum would silently discard the reading rather than report it.
pub fn gpu_load_from_engine_instances(pid: u32, items: &[(String, f64)]) -> Option<f64> {
    let mut total = 0.0;
    let mut matched = false;
    for (instance, value) in items {
        let lowered = instance.to_ascii_lowercase();
        if instance_is_pid(&lowered, pid) && is_3d_engine(&lowered) {
            total += value;
            matched = true;
        }
    }
    matched.then(|| total.clamp(0.0, 100.0))
}

/// `\GPU Process Memory(*)\Local Usage` instances → the process's VRAM in MiB.
///
/// Summed across adapters, since a process can hold allocations on more than
/// one. `Local Usage` is dedicated video memory specifically — shared system
/// memory is a separate counter and is deliberately not counted, because
/// `vramUsedMb` is compared against the card's dedicated capacity.
pub fn vram_from_process_memory_instances(pid: u32, items: &[(String, f64)]) -> Option<f64> {
    let mut bytes = 0.0;
    let mut matched = false;
    for (instance, value) in items {
        if instance_is_pid(&instance.to_ascii_lowercase(), pid) {
            bytes += value;
            matched = true;
        }
    }
    (matched && bytes > 0.0).then(|| (bytes / 1024.0 / 1024.0).round())
}

// ── CSV columns ─────────────────────────────────────────────────────────────

/// Column names appended to the capture stream.
///
/// Deliberately NOT PresentMon's own `GPUUtilization`/`GPUMemUsed` spellings.
/// The console application emits neither, so a file labelled as a PresentMon
/// capture carrying those names would credit Intel's tool with our data — the
/// exact confusion that sent this project chasing a nonexistent flag. The
/// parser maps these aliases explicitly (`internal/columns.ts`).
pub const TELEMETRY_HEADERS: [&str; 2] = ["HeimdallGpuUtilization", "HeimdallGpuMemUsedMb"];

/// Render a sample as trailing CSV cells. Absent readings become empty cells,
/// which `parseLocaleNumber` reads as `undefined` — never as 0.
pub fn telemetry_cells(sample: Option<GpuTelemetry>) -> String {
    let sample = sample.unwrap_or_default();
    let fmt = |value: Option<f64>| value.map(|v| format!("{v:.1}")).unwrap_or_default();
    format!(",{},{}", fmt(sample.gpu_load_pct), fmt(sample.vram_used_mb))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
        PDH_MORE_DATA,
    };

    const ENGINE_COUNTER: &str = r"\GPU Engine(*)\Utilization Percentage";
    const PROCESS_MEMORY_COUNTER: &str = r"\GPU Process Memory(*)\Local Usage";

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Live PDH query. Dropped on stop, which closes the underlying handle.
    pub struct TelemetrySampler {
        query: PDH_HQUERY,
        engine: PDH_HCOUNTER,
        memory: PDH_HCOUNTER,
        pid: u32,
    }

    impl Drop for TelemetrySampler {
        fn drop(&mut self) {
            // SAFETY: the handle came from PdhOpenQueryW and is closed once.
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    impl TelemetrySampler {
        /// Open the counters for `pid`. Returns `None` when the counters are
        /// unavailable — a machine without the GPU performance counter set is a
        /// capture with fewer sensors, not a failed capture.
        pub fn new(pid: u32) -> Option<Self> {
            let mut query = PDH_HQUERY::default();
            // SAFETY: out-parameter is a live local.
            if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
                return None;
            }

            let open = |path: &str| -> Option<PDH_HCOUNTER> {
                let wide_path = wide(path);
                let mut counter = PDH_HCOUNTER::default();
                // English counter names, not localized ones: the display names
                // differ per Windows UI language and would break every non-en
                // install. SAFETY: path and out-param outlive the call.
                let status = unsafe {
                    PdhAddEnglishCounterW(query, PCWSTR(wide_path.as_ptr()), 0, &mut counter)
                };
                (status == 0).then_some(counter)
            };

            let engine = open(ENGINE_COUNTER);
            let memory = open(PROCESS_MEMORY_COUNTER);
            let (Some(engine), Some(memory)) = (engine, memory) else {
                // SAFETY: query is valid; closing it releases any counter added
                // before the failure.
                unsafe {
                    let _ = PdhCloseQuery(query);
                }
                return None;
            };

            let sampler = Self {
                query,
                engine,
                memory,
                pid,
            };
            // Utilization Percentage is a rate counter: the first collect only
            // establishes a baseline and yields nothing usable. Prime it here so
            // the first real sample is already meaningful.
            sampler.collect();
            Some(sampler)
        }

        fn collect(&self) {
            // SAFETY: the query handle is valid for the sampler's lifetime.
            unsafe {
                let _ = PdhCollectQueryData(self.query);
            }
        }

        /// Read one sample. Never fails loudly: a counter that will not answer
        /// yields `None` for its field and the capture carries on.
        pub fn sample(&self) -> GpuTelemetry {
            self.collect();
            GpuTelemetry {
                gpu_load_pct: read_array(self.engine)
                    .and_then(|items| gpu_load_from_engine_instances(self.pid, &items)),
                vram_used_mb: read_array(self.memory)
                    .and_then(|items| vram_from_process_memory_instances(self.pid, &items)),
            }
        }
    }

    /// Wildcard counters return an array of (instance name, value). PDH wants
    /// the buffer sized by a first call that deliberately fails with
    /// `PDH_MORE_DATA`.
    fn read_array(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
        let mut size = 0u32;
        let mut count = 0u32;
        // SAFETY: a null buffer with live size/count out-params is the
        // documented way to ask PDH how much space the result needs.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
        };
        if status != PDH_MORE_DATA || size == 0 {
            return None;
        }

        let mut buffer = vec![0u8; size as usize];
        // SAFETY: the buffer is sized by the query above and correctly aligned
        // for the item struct, which PDH writes along with its trailing strings.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>()),
            )
        };
        if status != 0 {
            return None;
        }

        let mut items = Vec::with_capacity(count as usize);
        // SAFETY: PDH wrote `count` items at the head of the buffer.
        let entries = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                count as usize,
            )
        };
        for entry in entries {
            if entry.szName.is_null() {
                continue;
            }
            // SAFETY: szName points into the same buffer, NUL-terminated.
            let name = unsafe { entry.szName.to_string() }.unwrap_or_default();
            // SAFETY: the union holds a double because PDH_FMT_DOUBLE was asked
            // for and the call returned success.
            let value = unsafe { entry.FmtValue.Anonymous.doubleValue };
            if value.is_finite() {
                items.push((name, value));
            }
        }
        Some(items)
    }
}

#[cfg(not(windows))]
mod imp {
    //! Non-Windows stub — PDH is a Windows API. Reports "no sensors", which is
    //! a state every consumer already handles.
    use super::*;

    pub struct TelemetrySampler;

    impl TelemetrySampler {
        pub fn new(_pid: u32) -> Option<Self> {
            None
        }
        pub fn sample(&self) -> GpuTelemetry {
            GpuTelemetry::default()
        }
    }
}

pub use imp::TelemetrySampler;

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim PDH shape, capitalization included — see `is_3d_engine`.
    fn engine(pid: u32, eng: &str, value: f64) -> (String, f64) {
        (
            format!("pid_{pid}_luid_0x00000000_0x030C6551_phys_0_eng_0_engtype_{eng}"),
            value,
        )
    }

    #[test]
    fn attributes_load_to_the_captured_process_only() {
        let items = vec![engine(4242, "3D", 87.5), engine(9999, "3D", 42.0)];
        assert_eq!(gpu_load_from_engine_instances(4242, &items), Some(87.5));
        assert_eq!(gpu_load_from_engine_instances(9999, &items), Some(42.0));
        // A process that is not on the GPU has no reading — not 0% load.
        assert_eq!(gpu_load_from_engine_instances(1, &items), None);
    }

    #[test]
    fn counts_only_the_3d_engine() {
        // Video decode is not rendering. Counting it would report a process
        // playing a cutscene as busier than the engine drawing frames.
        let items = vec![
            engine(42, "3D", 60.0),
            engine(42, "VideoDecode", 95.0),
            engine(42, "Copy", 30.0),
        ];
        assert_eq!(gpu_load_from_engine_instances(42, &items), Some(60.0));
    }

    #[test]
    fn sums_multiple_3d_engines_but_clamps_to_a_plausible_percentage() {
        let items = vec![
            ("pid_42_luid_a_phys_0_eng_0_engtype_3D".into(), 70.0),
            ("pid_42_luid_a_phys_0_eng_1_engtype_3D".into(), 60.0),
        ];
        // Unclamped this would be 130, and the parser's plausibility guard
        // drops anything over 100 — silently losing the reading entirely.
        assert_eq!(gpu_load_from_engine_instances(42, &items), Some(100.0));
    }

    #[test]
    fn matches_the_capitalization_and_index_suffix_pdh_actually_emits() {
        // Both forms verified against raw PDH output. Matching the lowercased
        // shape PowerShell prints, or anchoring with ends_with, finds nothing.
        let items = vec![
            ("pid_42_luid_a_phys_0_eng_0_engtype_3D".into(), 40.0),
            ("pid_42_luid_a_phys_0_eng_2_engtype_3D 0".into(), 25.0),
            ("pid_42_luid_a_phys_0_eng_3_engtype_Compute 0".into(), 90.0),
        ];
        assert_eq!(gpu_load_from_engine_instances(42, &items), Some(65.0));
    }

    #[test]
    fn a_pid_prefix_does_not_match_a_longer_pid() {
        let items = vec![engine(6500, "3D", 50.0)];
        assert_eq!(gpu_load_from_engine_instances(650, &items), None);
    }

    #[test]
    fn sums_vram_across_adapters_and_converts_to_mib() {
        let items = vec![
            ("pid_42_luid_0x0_0x1_phys_0".into(), 512.0 * 1024.0 * 1024.0),
            ("pid_42_luid_0x0_0x2_phys_0".into(), 512.0 * 1024.0 * 1024.0),
            ("pid_99_luid_0x0_0x1_phys_0".into(), 999.0 * 1024.0 * 1024.0),
        ];
        assert_eq!(vram_from_process_memory_instances(42, &items), Some(1024.0));
    }

    #[test]
    fn zero_vram_is_no_reading_rather_than_a_zero_reading() {
        let items = vec![("pid_42_luid_0x0_0x1_phys_0".into(), 0.0)];
        assert_eq!(vram_from_process_memory_instances(42, &items), None);
        assert_eq!(vram_from_process_memory_instances(7, &items), None);
    }

    #[test]
    fn absent_readings_render_as_empty_cells_never_zero() {
        // The parser turns an empty cell into `undefined`. A literal 0 would
        // read as an idle GPU and drag every average built on it.
        assert_eq!(telemetry_cells(None), ",,");
        assert_eq!(
            telemetry_cells(Some(GpuTelemetry {
                gpu_load_pct: None,
                vram_used_mb: Some(8192.0),
            })),
            ",,8192.0"
        );
        assert_eq!(
            telemetry_cells(Some(GpuTelemetry {
                gpu_load_pct: Some(73.45),
                vram_used_mb: Some(8192.0),
            })),
            ",73.5,8192.0"
        );
    }

    #[test]
    fn headers_do_not_impersonate_presentmons_own_columns() {
        // PresentMon's console app emits no telemetry at all; naming ours
        // GPUUtilization would credit Intel's tool with our measurements.
        for header in TELEMETRY_HEADERS {
            assert!(header.starts_with("Heimdall"), "{header}");
        }
        assert_eq!(
            telemetry_cells(None).matches(',').count(),
            TELEMETRY_HEADERS.len()
        );
    }
}

#[cfg(all(test, windows))]
mod live_probe {
    use super::*;

    /// Not an assertion — a dev helper for confirming the PDH path against real
    /// counters on a real GPU. Ignored by default so CI never depends on what
    /// happens to be rendering.
    ///
    ///   $env:HEIMDALL_PROBE_PIDS="1188,6500"
    ///   cargo test -- --ignored --nocapture live_probe
    ///
    /// Note a browser or Electron app renders in a GPU CHILD process, so its
    /// main-window pid legitimately has no 3D instance. Games render in the
    /// foreground process, which is what the client targets.
    #[test]
    #[ignore]
    fn sample_a_real_process() {
        let pids: Vec<u32> = std::env::var("HEIMDALL_PROBE_PIDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|value| value.trim().parse().ok())
            .collect();
        assert!(
            !pids.is_empty(),
            "set HEIMDALL_PROBE_PIDS to a comma-separated pid list"
        );

        for pid in pids {
            let Some(sampler) = TelemetrySampler::new(pid) else {
                println!("pid {pid}: counters unavailable");
                continue;
            };
            std::thread::sleep(std::time::Duration::from_millis(SAMPLE_INTERVAL_MS));
            let sample = sampler.sample();
            println!(
                "pid {pid}: {sample:?}  cells='{}'",
                telemetry_cells(Some(sample))
            );
        }
    }
}
