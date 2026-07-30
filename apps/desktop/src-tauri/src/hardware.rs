//! Declared hardware and methodology facts (§22.2).
//!
//! Everything here is DECLARED by the client, never inferred from frames — the
//! parsers are explicit that tool version, HAGS and rated memory speed cannot
//! come from a capture file. This module is the whole reason the desktop client
//! unlocks diagnostics no browser upload can reach: `ramRatedSpeedMtps` vs
//! `ramSpeedMtps` is what lets the ram-below-rated rule (§15.3) fire at all.
//!
//! The shape is split in two on purpose:
//!
//! * [`HardwareSnapshot`] is quasi-identifying and follows the run through
//!   every deletion path, so it carries only what the schema declares. It
//!   deliberately has no `canonicalGpuId` / `canonicalCpuId` fields — the
//!   server strips and re-derives those at finalize (§11.6), and sending them
//!   would be a client claiming authority it does not have.
//! * [`MethodologyFacts`] carries the capture-environment declarations (HAGS,
//!   capture tool) that belong on the methodology manifest, not the snapshot.
//!
//! The pure mapping functions at the bottom are unit-tested against captured
//! rows; the Windows syscalls above them are not, which is exactly why the
//! mapping is separated out.

use serde::Serialize;

use crate::driver;

/// Client-declared hardware, matching `hardwareSnapshotSchema` field for field.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    pub gpu: String,
    pub cpu: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_gb: Option<f64>,
    /// What the modules are ACTUALLY running at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_speed_mtps: Option<u32>,
    /// What the SPD says they are RATED for. The gap between the two is the
    /// entire ram-below-rated diagnostic (§15.3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_rated_speed_mtps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_driver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_vram_total_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

/// Capture-environment declarations for the methodology manifest (§16c).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MethodologyFacts {
    /// Hardware-accelerated GPU scheduling. `None` means "could not be read" —
    /// reported as unknown rather than guessed at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hags: Option<bool>,
    /// `PresentMon <x.y.z>` — the pinned sidecar, verbatim (§2.2).
    pub capture_tool: String,
}

/// `runs.resolution` is an indexed metadata column with a hard 64-char bound.
const MAX_RESOLUTION_CHARS: usize = 64;

// ── Pure mapping ────────────────────────────────────────────────────────────

/// One `Win32_PhysicalMemory` row, reduced to the three fields that matter.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MemoryModule {
    /// Bytes.
    pub capacity: u64,
    /// SPD rated speed, MT/s. `Speed` in WMI.
    pub rated_mtps: u32,
    /// Speed the module is actually clocked at. `ConfiguredClockSpeed` in WMI.
    pub configured_mtps: u32,
}

/// Installed memory modules → the three RAM fields of the snapshot.
///
/// Capacity sums. Speeds take the MINIMUM across modules, not the maximum or
/// the first row: a mixed kit runs the whole channel at the slowest module, so
/// the minimum is the speed the machine actually experiences — and reporting
/// the fastest stick would hide exactly the misconfiguration the diagnostic
/// exists to catch. A zero is WMI's "not reported", never a real speed.
///
/// ── Why `Speed` is not simply reported as the rated speed ───────────────────
///
/// `Win32_PhysicalMemory.Speed` is documented as the module's maximum capable
/// speed, but what BIOSes actually put there varies, and the two observed
/// patterns disagree:
///
/// * Some report the XMP/EXPO rating, e.g. Speed 6000 / Configured 4800 with
///   the profile switched off. That IS what the ram-below-rated rule (§15.3)
///   wants.
/// * Others report the JEDEC base regardless, e.g. Speed 4800 / Configured 6000
///   on a Ryzen 9800X3D with EXPO enabled — verified on real hardware during
///   Phase 9. Here `Speed` is a floor, not a rating.
///
/// The true XMP/EXPO profile lives in the SPD EEPROM behind SMBus and is not
/// reachable from a user-mode process at all. So `Speed` is declared as
/// `ramRatedSpeedMtps` ONLY when it exceeds the running speed — the one case
/// where it demonstrably describes a capability above what is configured.
/// Otherwise the field is omitted and the diagnostic self-suppresses on the
/// missing value, exactly as it does for a browser upload.
///
/// Declaring the JEDEC base as a "rating" instead would be worse than useless:
/// it would tell a user with EXPO correctly enabled that their RAM is fine
/// *because* the numbers happen to look right, and on a machine where the two
/// agree it would assert a rating the client cannot actually know.
pub fn memory_fields(modules: &[MemoryModule]) -> (Option<f64>, Option<u32>, Option<u32>) {
    let bytes: u64 = modules.iter().map(|m| m.capacity).sum();
    let gb = if bytes == 0 {
        None
    } else {
        // Binary GiB, rounded to one decimal: 32.0, not 34.36.
        Some((bytes as f64 / 1024.0 / 1024.0 / 1024.0 * 10.0).round() / 10.0)
    };
    let configured = modules
        .iter()
        .map(|m| m.configured_mtps)
        .filter(|v| *v > 0)
        .min();
    let reported = modules
        .iter()
        .map(|m| m.rated_mtps)
        .filter(|v| *v > 0)
        .min();
    let rated = match (reported, configured) {
        (Some(reported), Some(configured)) if reported > configured => Some(reported),
        // No running speed to compare against: `Speed` is the only number
        // there is, so take it at its documented meaning.
        (Some(reported), None) => Some(reported),
        _ => None,
    };
    (gb, configured, rated)
}

/// `HwSchMode` → hardware-accelerated GPU scheduling state.
///
/// The registry value is tri-state and the third state is real: 2 is enabled,
/// 1 is disabled, and anything else — including the value being absent on a
/// machine whose driver never wrote it — means the client does not know. It
/// reports unknown rather than defaulting to "off", because a wrong
/// declaration here is worse than a missing one: methodology fields feed
/// comparability, and a fabricated value would silently split runs.
pub fn hags_state(hw_sch_mode: Option<u32>) -> Option<bool> {
    match hw_sch_mode {
        Some(2) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// Display mode → the `WIDTHxHEIGHT` string the schema indexes.
pub fn resolution_label(width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }
    let label = format!("{width}x{height}");
    (label.len() <= MAX_RESOLUTION_CHARS).then_some(label)
}

/// `Win32_OperatingSystem` caption + build → one display string.
pub fn os_label(caption: &str, build: &str) -> Option<String> {
    let caption = caption.trim();
    let build = build.trim();
    match (caption.is_empty(), build.is_empty()) {
        (true, true) => None,
        (true, false) => Some(format!("Build {build}")),
        (false, true) => Some(caption.to_string()),
        (false, false) => Some(format!("{caption} (build {build})")),
    }
}

/// Bytes of dedicated video memory → MiB, as the schema's positive number.
pub fn vram_mb(dedicated_bytes: u64) -> Option<f64> {
    if dedicated_bytes == 0 {
        return None;
    }
    Some((dedicated_bytes as f64 / 1024.0 / 1024.0).round())
}

/// Assemble the snapshot from already-collected parts.
///
/// Kept separate from collection so the field-level rules — the
/// `UNKNOWN_HARDWARE`-style placeholders for the two required fields, vendor
/// mapping, driver normalization — are testable without a GPU.
#[allow(clippy::too_many_arguments)]
pub fn build_snapshot(
    gpu: &str,
    vendor_id: u32,
    dedicated_vram_bytes: u64,
    internal_driver: &str,
    radeon_software: Option<&str>,
    cpu: &str,
    modules: &[MemoryModule],
    os: Option<String>,
    resolution: Option<String>,
) -> HardwareSnapshot {
    let (ram_gb, ram_speed_mtps, ram_rated_speed_mtps) = memory_fields(modules);
    let gpu = gpu.trim();
    let cpu = cpu.trim();
    let driver = driver::marketing_driver_version(vendor_id, internal_driver, radeon_software);

    HardwareSnapshot {
        // The schema requires non-empty strings. Matching the ingest engine's
        // UNKNOWN_HARDWARE placeholders keeps a machine we cannot read from
        // failing validation outright.
        gpu: if gpu.is_empty() {
            "Unknown GPU".into()
        } else {
            gpu.into()
        },
        cpu: if cpu.is_empty() {
            "Unknown CPU".into()
        } else {
            cpu.into()
        },
        gpu_vendor: Some(driver::vendor_slug(vendor_id).into()),
        ram_gb,
        ram_speed_mtps,
        ram_rated_speed_mtps,
        os,
        gpu_driver: (!driver.trim().is_empty()).then_some(driver),
        gpu_vram_total_mb: vram_mb(dedicated_vram_bytes),
        resolution,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(gb: u64, rated: u32, configured: u32) -> MemoryModule {
        MemoryModule {
            capacity: gb * 1024 * 1024 * 1024,
            rated_mtps: rated,
            configured_mtps: configured,
        }
    }

    #[test]
    fn sums_capacity_and_reports_the_slowest_module_on_each_axis() {
        let (gb, configured, rated) =
            memory_fields(&[module(16, 6000, 4800), module(16, 5600, 5600)]);
        assert_eq!(gb, Some(32.0));
        // The channel runs at the slowest stick, and that is what the user feels.
        assert_eq!(configured, Some(4800));
        assert_eq!(rated, Some(5600));
    }

    #[test]
    fn a_kit_running_below_spd_is_visible_to_the_ram_below_rated_rule() {
        let (_, configured, rated) =
            memory_fields(&[module(16, 6000, 4800), module(16, 6000, 4800)]);
        assert_eq!((configured, rated), (Some(4800), Some(6000)));
        assert!(
            configured < rated,
            "EXPO/XMP off must be observable (§15.3)"
        );
    }

    #[test]
    fn a_bios_reporting_the_jedec_base_declares_no_rating_at_all() {
        // Verified on real hardware (Ryzen 9800X3D, EXPO enabled): WMI reports
        // Speed 4800 / ConfiguredClockSpeed 6000. 4800 is a floor, not a
        // rating, so nothing is declared and the rule self-suppresses rather
        // than reassuring the user on a number the client cannot know.
        let (_, configured, rated) =
            memory_fields(&[module(16, 4800, 6000), module(16, 4800, 6000)]);
        assert_eq!(configured, Some(6000));
        assert_eq!(rated, None);
    }

    #[test]
    fn speeds_that_merely_agree_are_not_evidence_of_a_rating() {
        // Indistinguishable from the JEDEC-base case, so it claims nothing.
        let (_, configured, rated) = memory_fields(&[module(16, 5600, 5600)]);
        assert_eq!(configured, Some(5600));
        assert_eq!(rated, None);
    }

    #[test]
    fn with_no_running_speed_the_reported_maximum_is_taken_at_face_value() {
        let (_, configured, rated) = memory_fields(&[module(16, 5600, 0)]);
        assert_eq!(configured, None);
        assert_eq!(rated, Some(5600));
    }

    #[test]
    fn wmi_zeroes_mean_not_reported_not_a_real_speed() {
        let (gb, configured, rated) = memory_fields(&[module(0, 0, 0)]);
        assert_eq!((gb, configured, rated), (None, None, None));
    }

    #[test]
    fn hags_is_tri_state_and_never_guesses() {
        assert_eq!(hags_state(Some(2)), Some(true));
        assert_eq!(hags_state(Some(1)), Some(false));
        // Absent, or a value this build has never seen: unknown, not "off".
        assert_eq!(hags_state(None), None);
        assert_eq!(hags_state(Some(0)), None);
        assert_eq!(hags_state(Some(7)), None);
    }

    #[test]
    fn resolution_and_os_labels_degrade_instead_of_fabricating() {
        assert_eq!(resolution_label(2560, 1440).as_deref(), Some("2560x1440"));
        assert_eq!(resolution_label(0, 1440), None);
        assert_eq!(
            os_label("Windows 11 Home", "26200").as_deref(),
            Some("Windows 11 Home (build 26200)")
        );
        assert_eq!(
            os_label("Windows 11 Home", "").as_deref(),
            Some("Windows 11 Home")
        );
        assert_eq!(os_label("", ""), None);
    }

    #[test]
    fn vram_bytes_become_whole_mib() {
        assert_eq!(vram_mb(24u64 * 1024 * 1024 * 1024), Some(24576.0));
        assert_eq!(vram_mb(0), None);
    }

    #[test]
    fn snapshot_round_trips_the_schema_field_names_and_omits_canonical_ids() {
        let snapshot = build_snapshot(
            "AMD Radeon RX 7900 XTX",
            driver::VENDOR_AMD,
            24u64 * 1024 * 1024 * 1024,
            "32.0.12033.1030",
            Some("25.5.1"),
            "AMD Ryzen 7 7800X3D 8-Core Processor",
            &[module(16, 6000, 4800), module(16, 6000, 4800)],
            os_label("Windows 11 Home", "26200"),
            resolution_label(2560, 1440),
        );
        let json = serde_json::to_value(&snapshot).unwrap();

        assert_eq!(json["gpu"], "AMD Radeon RX 7900 XTX");
        assert_eq!(json["gpuVendor"], "amd");
        assert_eq!(json["gpuDriver"], "25.5.1");
        assert_eq!(json["gpuVramTotalMb"], 24576.0);
        assert_eq!(json["ramGb"], 32.0);
        assert_eq!(json["ramSpeedMtps"], 4800);
        assert_eq!(json["ramRatedSpeedMtps"], 6000);
        assert_eq!(json["resolution"], "2560x1440");
        // The server strips and re-derives these at finalize (§11.6); a client
        // that sent them would be claiming authority it does not have.
        assert!(json.get("canonicalGpuId").is_none());
        assert!(json.get("canonicalCpuId").is_none());
    }

    #[test]
    fn an_unreadable_machine_still_satisfies_the_two_required_fields() {
        let snapshot = build_snapshot("", 0, 0, "", None, "  ", &[], None, None);
        assert_eq!(snapshot.gpu, "Unknown GPU");
        assert_eq!(snapshot.cpu, "Unknown CPU");
        assert_eq!(snapshot.gpu_vendor.as_deref(), Some("unknown"));
        let json = serde_json::to_value(&snapshot).unwrap();
        assert!(json.get("ramGb").is_none());
        assert!(json.get("gpuDriver").is_none());
    }
}
