//! GPU driver version normalization (§22.2) — pure, so it is fully unit-tested.
//!
//! Windows reports a four-part internal driver version
//! (`HKLM\...\Video\{guid}\0000\DriverVersion`, e.g. `32.0.15.6636`) that no
//! user recognizes and that the driver-currency rules (§15.4, Phase 6.6) cannot
//! match: the curated feed records *marketing* versions — NVIDIA `566.36`, AMD
//! Adrenalin `25.5.1`, Intel `101.6314`. Getting this mapping wrong does not
//! throw; it silently makes every driver-currency rule miss, so it is worth the
//! table of cases below.

/// PCI vendor ids, as DXGI reports them in `DXGI_ADAPTER_DESC.VendorId`.
pub const VENDOR_NVIDIA: u32 = 0x10DE;
pub const VENDOR_AMD: u32 = 0x1002;
pub const VENDOR_AMD_ATI: u32 = 0x1022;
pub const VENDOR_INTEL: u32 = 0x8086;

/// DXGI vendor id → the `gpuVendor` enum in `hardwareSnapshotSchema`.
pub fn vendor_slug(vendor_id: u32) -> &'static str {
    match vendor_id {
        VENDOR_NVIDIA => "nvidia",
        VENDOR_AMD | VENDOR_AMD_ATI => "amd",
        VENDOR_INTEL => "intel",
        _ => "unknown",
    }
}

/// Internal `DriverVersion` → the marketing string users and the
/// driver-currency feed both speak.
///
/// * NVIDIA packs the marketing version into the last five digits of the
///   concatenated version: `32.0.15.6636` → `56636` → `566.36`.
/// * Intel uses the last two components verbatim: `32.0.101.6314` → `101.6314`.
/// * AMD's marketing version (Adrenalin `25.5.1`) is not derivable from the
///   internal version at all — it is published separately in the registry as
///   `RadeonSoftwareVersion`. When that string is present it wins outright;
///   with no string there is nothing honest to report, so the raw internal
///   version is returned rather than a guess.
pub fn marketing_driver_version(vendor_id: u32, internal: &str, radeon: Option<&str>) -> String {
    let internal = internal.trim();
    match vendor_id {
        VENDOR_NVIDIA => nvidia_marketing(internal).unwrap_or_else(|| internal.to_string()),
        VENDOR_INTEL => intel_marketing(internal).unwrap_or_else(|| internal.to_string()),
        VENDOR_AMD | VENDOR_AMD_ATI => radeon
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| internal.to_string()),
        _ => internal.to_string(),
    }
}

fn nvidia_marketing(internal: &str) -> Option<String> {
    let digits: String = internal.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 5 {
        return None;
    }
    let tail = &digits[digits.len() - 5..];
    Some(format!("{}.{}", &tail[..3], &tail[3..]))
}

fn intel_marketing(internal: &str) -> Option<String> {
    let parts: Vec<&str> = internal.split('.').collect();
    if parts.len() < 4 {
        return None;
    }
    Some(format!(
        "{}.{}",
        parts[parts.len() - 2],
        parts[parts.len() - 1]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_dxgi_vendor_ids_to_the_schema_enum() {
        assert_eq!(vendor_slug(VENDOR_NVIDIA), "nvidia");
        assert_eq!(vendor_slug(VENDOR_AMD), "amd");
        assert_eq!(vendor_slug(VENDOR_AMD_ATI), "amd");
        assert_eq!(vendor_slug(VENDOR_INTEL), "intel");
        // Never invent a vendor: unknown silicon reports unknown.
        assert_eq!(vendor_slug(0x1234), "unknown");
    }

    #[test]
    fn nvidia_internal_versions_become_the_published_branch_number() {
        for (internal, expected) in [
            ("32.0.15.6636", "566.36"),
            ("31.0.15.5222", "552.22"),
            ("32.0.15.7602", "576.02"),
        ] {
            assert_eq!(
                marketing_driver_version(VENDOR_NVIDIA, internal, None),
                expected
            );
        }
    }

    #[test]
    fn intel_keeps_the_last_two_components() {
        assert_eq!(
            marketing_driver_version(VENDOR_INTEL, "32.0.101.6314", None),
            "101.6314"
        );
    }

    #[test]
    fn amd_prefers_the_published_adrenalin_string_over_the_internal_version() {
        assert_eq!(
            marketing_driver_version(VENDOR_AMD, "32.0.12033.1030", Some("25.5.1")),
            "25.5.1"
        );
    }

    #[test]
    fn amd_without_an_adrenalin_string_reports_the_raw_version_rather_than_guessing() {
        assert_eq!(
            marketing_driver_version(VENDOR_AMD, "32.0.12033.1030", None),
            "32.0.12033.1030"
        );
        assert_eq!(
            marketing_driver_version(VENDOR_AMD, "32.0.12033.1030", Some("   ")),
            "32.0.12033.1030"
        );
    }

    #[test]
    fn a_malformed_version_passes_through_untouched() {
        assert_eq!(marketing_driver_version(VENDOR_NVIDIA, "1.0", None), "1.0");
        assert_eq!(
            marketing_driver_version(VENDOR_INTEL, "101.6314", None),
            "101.6314"
        );
        assert_eq!(marketing_driver_version(0x1234, "9.9.9.9", None), "9.9.9.9");
    }
}
