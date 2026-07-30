//! Linux system access (§23.2): CPU, memory, OS, DRM adapter, display mode.
//!
//! `win.rs`'s sibling, same idiom — a `#[cfg]`-selected `mod imp` with a
//! "not available" stub — and the same discipline: everything decidable without
//! a filesystem read is a pure function at the bottom of this file and is unit
//! tested against captured `/proc` and `/sys` text, so the tests run on the
//! Windows CI job too.
//!
//! ── What this module is NOT ─────────────────────────────────────────────────
//!
//! It is not the primary hardware source on Linux. **MangoHud's sysinfo row
//! is** (§23.2): the log's own `gpu` / `cpu` / `os` / `driver` / `ram` fields
//! come from the tool that was actually inside the game, and `driver` is where
//! the Mesa version string lives — the exact value
//! `docs/driver-currency-curation.md` locks as the Linux driver-currency
//! contract. This module fills the gaps MangoHud leaves and nothing more; the
//! webview drops any field the capture itself supplied (see
//! `src/lib/hardware.ts`) so a `/sys` read can never overwrite `Mesa 26.1.4`
//! with a kernel module name.
//!
//! Consequently there is deliberately no GPU *name* here. Naming a PCI device
//! needs a hardware database we do not ship, and "Unknown GPU" that MangoHud
//! then replaces is honest where a fabricated `amdgpu 0x7550` would not be.
//!
//! ── Deliberately absent ─────────────────────────────────────────────────────
//!
//! * `ramSpeedMtps` / `ramRatedSpeedMtps` — the running and rated memory speeds
//!   live in DMI, and `/sys/firmware/dmi/tables` is root-only on every distro
//!   we care about. A per-user client cannot read them, so the fields are
//!   omitted and the ram-below-rated rule (§15.3) self-suppresses on the
//!   missing value. That is the invariant working, not a gap to paper over: a
//!   fabricated rating would tell a user their RAM is fine on a number nobody
//!   measured.
//! * HAGS — a Windows scheduling concept with no Linux counterpart. Reported as
//!   unknown, never as `false`; declaring it disabled would be a claim about a
//!   setting that does not exist here, and methodology fields feed
//!   comparability.

use crate::hardware::{HardwareSnapshot, MethodologyFacts};

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::path::{Path, PathBuf};

    use crate::mangohud;

    fn read(path: impl AsRef<Path>) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    /// The DRM card whose hardware we report.
    ///
    /// First `cardN` in sorted order that exposes a PCI vendor id. On a hybrid
    /// laptop that is usually the integrated GPU, which is the wrong answer —
    /// but MangoHud names the GPU the game actually rendered on and its value
    /// wins the merge, so the cost of being wrong here is limited to the VRAM
    /// total and the vendor slug. Reading the game's own adapter would mean
    /// resolving its DRM fd, which the watcher model gives us no handle on.
    fn primary_card() -> Option<PathBuf> {
        let mut cards: Vec<PathBuf> = std::fs::read_dir("/sys/class/drm")
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    // `card0`, not `card0-DP-1`: the latter is a connector.
                    .is_some_and(|name| name.starts_with("card") && !name.contains('-'))
            })
            .filter(|path| path.join("device").join("vendor").is_file())
            .collect();
        cards.sort();
        cards.into_iter().next()
    }

    /// `WIDTHxHEIGHT` of the first connected connector's preferred mode.
    ///
    /// Straight out of sysfs with no X11 or Wayland dependency, which is the
    /// only way this works in SteamOS gaming mode — there is no display server
    /// we can talk to there in the way a desktop session offers one.
    fn resolution() -> Option<String> {
        let mut connectors: Vec<PathBuf> = std::fs::read_dir("/sys/class/drm")
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("card") && name.contains('-'))
            })
            .collect();
        connectors.sort();
        for connector in connectors {
            let status = read(connector.join("status")).unwrap_or_default();
            if status.trim() != "connected" {
                continue;
            }
            if let Some(label) = super::preferred_mode(&read(connector.join("modes"))?) {
                return Some(label);
            }
        }
        None
    }

    pub fn collect_hardware() -> (HardwareSnapshot, MethodologyFacts) {
        let card = primary_card();
        let device = card.as_ref().map(|card| card.join("device"));
        let kernel = read("/proc/sys/kernel/osrelease").unwrap_or_default();

        let vendor_id = device
            .as_ref()
            .and_then(|device| read(device.join("vendor")))
            .map(|raw| super::pci_vendor_id(&raw))
            .unwrap_or(0);
        // The `driver` entry is a symlink into the module's sysfs directory; its
        // final component is the module name (`amdgpu`, `i915`, `xe`, `nvidia`).
        let module = device
            .as_ref()
            .and_then(|device| std::fs::read_link(device.join("driver")).ok())
            .and_then(|target| {
                target
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            });

        let snapshot = super::build_snapshot(super::LinuxFacts {
            vendor_id,
            cpuinfo: read("/proc/cpuinfo").unwrap_or_default(),
            meminfo: read("/proc/meminfo").unwrap_or_default(),
            os_release: read("/etc/os-release").unwrap_or_default(),
            kernel: kernel.clone(),
            driver_module: module,
            vram_total: device
                .as_ref()
                .and_then(|device| read(device.join("mem_info_vram_total"))),
            resolution: resolution(),
        });

        let facts = MethodologyFacts {
            // Not a Linux concept; see the module header.
            hags: None,
            capture_tool: capture_tool(),
        };
        (snapshot, facts)
    }

    /// `captureTool` for the methodology manifest (§2.2).
    ///
    /// Asks MangoHud rather than pinning a version: unlike the Windows sidecar
    /// this is the *user's* install, so the only honest provenance is what it
    /// reports about itself. If it is absent or does not answer we say the
    /// version is unknown instead of inventing one.
    pub fn capture_tool() -> String {
        std::process::Command::new("mangohud")
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                let text = String::from_utf8_lossy(&output.stdout).into_owned();
                mangohud::parse_version_output(&text)
            })
            .unwrap_or_else(|| mangohud::UNKNOWN_CAPTURE_TOOL.to_string())
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    //! Non-Linux stub, mirroring `win.rs`'s.
    //!
    //! Exists so `cargo test`, `cargo clippy` and editor tooling work on a
    //! Windows or macOS checkout without `#[cfg]` at every call site. It reports
    //! "not available" rather than fabricating plausible hardware.

    use super::*;

    pub fn collect_hardware() -> (HardwareSnapshot, MethodologyFacts) {
        (
            HardwareSnapshot {
                gpu: "Unknown GPU".into(),
                cpu: "Unknown CPU".into(),
                gpu_vendor: Some("unknown".into()),
                ..HardwareSnapshot::default()
            },
            MethodologyFacts {
                hags: None,
                capture_tool: capture_tool(),
            },
        )
    }

    pub fn capture_tool() -> String {
        crate::mangohud::UNKNOWN_CAPTURE_TOOL.to_string()
    }
}

// The stub half of this module exists so a Windows or macOS checkout builds,
// lints and — crucially — runs the pure mapper tests below. Nothing calls into
// it there, which is the point, so its re-exports are unused off Linux.
#[cfg_attr(not(target_os = "linux"), allow(unused_imports))]
pub use imp::{capture_tool, collect_hardware};

// ── Pure mapping ────────────────────────────────────────────────────────────

/// Everything `collect_hardware` read, as text. Passing the raw file contents
/// through keeps the assembly rules testable without a Linux filesystem — the
/// same split `win.rs` and `hardware.rs` already use.
pub struct LinuxFacts {
    pub vendor_id: u32,
    pub cpuinfo: String,
    pub meminfo: String,
    pub os_release: String,
    pub kernel: String,
    pub driver_module: Option<String>,
    pub vram_total: Option<String>,
    pub resolution: Option<String>,
}

/// Assemble the snapshot from already-read files.
///
/// Note what is NOT set: `gpu` is the placeholder, because this module refuses
/// to name a PCI device (see the header), and the RAM speed fields are absent
/// because DMI is unreadable. Both are filled or left alone downstream rather
/// than guessed at here.
pub fn build_snapshot(facts: LinuxFacts) -> HardwareSnapshot {
    let cpu = cpu_model(&facts.cpuinfo);
    HardwareSnapshot {
        // The schema requires non-empty strings, and MangoHud's sysinfo row
        // supplies the real names when the log carries one.
        gpu: "Unknown GPU".into(),
        cpu: cpu.unwrap_or_else(|| "Unknown CPU".into()),
        gpu_vendor: Some(crate::driver::vendor_slug(facts.vendor_id).into()),
        ram_gb: ram_gb(&facts.meminfo),
        // DMI is root-only; see the module header.
        ram_speed_mtps: None,
        ram_rated_speed_mtps: None,
        os: os_label(&facts.os_release, &facts.kernel),
        gpu_driver: facts
            .driver_module
            .as_deref()
            .and_then(|module| driver_label(module, &facts.kernel)),
        gpu_vram_total_mb: facts.vram_total.as_deref().and_then(vram_total_mb),
        resolution: facts.resolution,
    }
}

/// `/proc/cpuinfo` → the marketing CPU name.
///
/// `model name` is the line every x86 kernel writes and is what users and the
/// canonical-id derivation both recognize. It repeats once per logical core, so
/// the first occurrence is taken.
pub fn cpu_model(cpuinfo: &str) -> Option<String> {
    let field = |wanted: &str| {
        cpuinfo
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once(':')?;
                (key.trim().eq_ignore_ascii_case(wanted)).then(|| value.trim())
            })
            .find(|value| !value.is_empty())
            .map(str::to_string)
    };
    // `model name` is searched to exhaustion BEFORE falling back to `model`,
    // not whichever appears first: x86 cpuinfo carries both, and `model` there
    // is the numeric CPU model id. Taking the first match would report a CPU
    // called "68".
    //
    // The fallback exists for aarch64 kernels, which emit no `model name` — it
    // matters for an ARM handheld.
    field("model name").or_else(|| field("model"))
}

/// `/proc/meminfo` `MemTotal` → binary GiB, rounded to one decimal.
///
/// The same rounding `hardware::memory_fields` applies on Windows, so 32 GB of
/// RAM reads as `32.0` on both platforms rather than `31.3` on one of them.
/// MemTotal excludes memory the firmware reserved, so this is slightly under
/// the installed capacity — that is what the kernel can actually use, and it is
/// the same number every Linux tool reports.
pub fn ram_gb(meminfo: &str) -> Option<f64> {
    let kb = meminfo.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim().eq_ignore_ascii_case("MemTotal")).then_some(value)
    })?;
    let kb: f64 = kb.trim().trim_end_matches("kB").trim().parse().ok()?;
    if kb <= 0.0 {
        return None;
    }
    Some((kb / 1024.0 / 1024.0 * 10.0).round() / 10.0)
}

/// `/etc/os-release` + kernel release → one display string.
///
/// The kernel is folded into `os` on purpose. MangoHud emits a `kernel` sysinfo
/// key and `hardwareSnapshotSchema` has no field for it; adding one is a schema
/// change that would ripple through the repositories, the run page and the
/// comparability keys, and Phase 9.5 does not need it. The kernel still matters
/// for Linux diagnostics — Mesa features track kernel versions — so it is
/// carried where a human and a curator can both read it:
/// `SteamOS 3.7.13 (kernel 6.11.11-valve)`.
pub fn os_label(os_release: &str, kernel: &str) -> Option<String> {
    let pretty = os_release.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "PRETTY_NAME").then(|| value.trim().trim_matches('"').to_string())
    });
    let kernel = kernel.trim();
    match (
        pretty.as_deref().map(str::trim).filter(|v| !v.is_empty()),
        kernel.is_empty(),
    ) {
        (Some(pretty), false) => Some(format!("{pretty} (kernel {kernel})")),
        (Some(pretty), true) => Some(pretty.to_string()),
        (None, false) => Some(format!("Linux (kernel {kernel})")),
        (None, true) => None,
    }
}

/// Kernel module + release → the `gpuDriver` fallback.
///
/// A LAST RESORT, and labelled as one. `amdgpu` is a kernel module, not a
/// driver version, and the driver-currency rules (§15.4) match Mesa release
/// strings — so this value deliberately cannot be mistaken for one. It exists
/// so a capture with no MangoHud sysinfo row still says something true about
/// what rendered it, and the webview drops it outright the moment MangoHud
/// supplies the real `Mesa <version>`.
pub fn driver_label(module: &str, kernel: &str) -> Option<String> {
    let module = module.trim();
    if module.is_empty() {
        return None;
    }
    let kernel = kernel.trim();
    Some(if kernel.is_empty() {
        module.to_string()
    } else {
        format!("{module} (kernel {kernel})")
    })
}

/// `/sys/class/drm/card*/device/vendor` → the PCI vendor id.
///
/// PCI vendor ids and the ids DXGI reports are the same numbers (0x1002 AMD,
/// 0x10DE NVIDIA, 0x8086 Intel), which is why `driver::vendor_slug` is reused
/// verbatim instead of a second Linux table that could drift from it.
pub fn pci_vendor_id(raw: &str) -> u32 {
    let raw = raw.trim();
    let hex = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"));
    match hex {
        Some(hex) => u32::from_str_radix(hex, 16).unwrap_or(0),
        // Not the documented format; report unknown rather than reinterpreting
        // the digits as decimal and landing on a real but wrong vendor.
        None => 0,
    }
}

/// `mem_info_vram_total` (bytes) → MiB.
///
/// amdgpu and i915/xe expose this; the NVIDIA proprietary driver exposes
/// nothing here. That case returns `None`, so the field is OMITTED rather than
/// sent as 0 — a VRAM total of zero would make the vram-saturation rule (§15.1)
/// read every capture as over capacity.
pub fn vram_total_mb(raw: &str) -> Option<f64> {
    let bytes: u64 = raw.trim().parse().ok()?;
    crate::hardware::vram_mb(bytes)
}

/// A connector's `modes` list → `WIDTHxHEIGHT`.
///
/// The first line is the preferred mode, which for a fixed-panel device (the
/// Deck, a laptop) is its native resolution and for a desktop monitor is what
/// it reports as preferred. Not necessarily what the game rendered at — that is
/// why `resolution` remains a declared field the user can correct.
pub fn preferred_mode(modes: &str) -> Option<String> {
    let first = modes.lines().map(str::trim).find(|line| !line.is_empty())?;
    let (width, height) = first.split_once('x')?;
    let width: u32 = width.parse().ok()?;
    // Some kernels suffix an interlace marker, e.g. `1920x1080i`.
    let height: u32 = height.trim_end_matches(['i', 'p']).parse().ok()?;
    crate::hardware::resolution_label(width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CPUINFO: &str = "\
processor\t: 0
vendor_id\t: AuthenticAMD
cpu family\t: 26
model\t\t: 68
model name\t: AMD Ryzen 7 9800X3D 8-Core Processor
stepping\t: 0
processor\t: 1
model name\t: AMD Ryzen 7 9800X3D 8-Core Processor
";

    const MEMINFO: &str = "\
MemTotal:       32724312 kB
MemFree:         1234567 kB
SwapTotal:       8388608 kB
";

    const OS_RELEASE: &str = "\
NAME=\"SteamOS\"
PRETTY_NAME=\"SteamOS 3.7.13\"
ID=steamos
VERSION_ID=3.7.13
";

    #[test]
    fn reads_the_cpu_name_once_from_a_multi_core_cpuinfo() {
        assert_eq!(
            cpu_model(CPUINFO).as_deref(),
            Some("AMD Ryzen 7 9800X3D 8-Core Processor")
        );
    }

    #[test]
    fn the_numeric_model_id_never_wins_over_the_model_name() {
        // x86 cpuinfo carries `model : 68` ABOVE `model name`. Taking the first
        // key that matches either reported a CPU called "68".
        assert!(CPUINFO.find("model\t\t:").unwrap() < CPUINFO.find("model name").unwrap());
        assert_eq!(
            cpu_model(CPUINFO).as_deref(),
            Some("AMD Ryzen 7 9800X3D 8-Core Processor")
        );
    }

    #[test]
    fn falls_back_to_model_on_kernels_with_no_model_name_line() {
        assert_eq!(
            cpu_model("Processor\t: 0\nModel\t: Qualcomm Snapdragon X\n").as_deref(),
            Some("Qualcomm Snapdragon X")
        );
        assert_eq!(cpu_model(""), None);
        assert_eq!(cpu_model("model name\t:   \n"), None);
    }

    #[test]
    fn memtotal_becomes_the_same_rounded_gib_windows_reports() {
        // 32724312 kB is a 32 GB machine minus firmware-reserved memory.
        assert_eq!(ram_gb(MEMINFO), Some(31.2));
        assert_eq!(ram_gb("MemTotal: 16777216 kB\n"), Some(16.0));
        assert_eq!(ram_gb("MemFree: 100 kB\n"), None);
        assert_eq!(ram_gb("MemTotal: 0 kB\n"), None);
        assert_eq!(ram_gb(""), None);
    }

    #[test]
    fn the_kernel_is_folded_into_the_os_string_rather_than_dropped() {
        // hardwareSnapshotSchema has no kernel field and Phase 9.5 does not add
        // one; losing the value entirely would cost Linux diagnostics more than
        // carrying it here does.
        assert_eq!(
            os_label(OS_RELEASE, "6.11.11-valve\n").as_deref(),
            Some("SteamOS 3.7.13 (kernel 6.11.11-valve)")
        );
    }

    #[test]
    fn os_labelling_degrades_instead_of_fabricating() {
        assert_eq!(os_label(OS_RELEASE, "").as_deref(), Some("SteamOS 3.7.13"));
        assert_eq!(
            os_label("ID=weird\n", "6.11.0").as_deref(),
            Some("Linux (kernel 6.11.0)")
        );
        assert_eq!(os_label("", ""), None);
        // Quotes are os-release syntax, not part of the name.
        assert_eq!(
            os_label("PRETTY_NAME=\"Arch Linux\"\n", "").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(
            os_label("PRETTY_NAME=Arch Linux\n", "").as_deref(),
            Some("Arch Linux")
        );
    }

    #[test]
    fn pci_vendor_ids_are_the_same_numbers_dxgi_reports() {
        use crate::driver;
        assert_eq!(pci_vendor_id("0x1002\n"), driver::VENDOR_AMD);
        assert_eq!(pci_vendor_id("0x10de\n"), driver::VENDOR_NVIDIA);
        assert_eq!(pci_vendor_id("0x10DE"), driver::VENDOR_NVIDIA);
        assert_eq!(pci_vendor_id("0x8086"), driver::VENDOR_INTEL);
        assert_eq!(driver::vendor_slug(pci_vendor_id("0x1002\n")), "amd");
        // Never reinterpret an unexpected format; 1002 decimal is a real but
        // different vendor.
        assert_eq!(pci_vendor_id("1002"), 0);
        assert_eq!(pci_vendor_id(""), 0);
        assert_eq!(driver::vendor_slug(pci_vendor_id("garbage")), "unknown");
    }

    #[test]
    fn the_kernel_module_is_labelled_so_it_cannot_pass_for_a_mesa_version() {
        assert_eq!(
            driver_label("amdgpu", "6.11.11-valve").as_deref(),
            Some("amdgpu (kernel 6.11.11-valve)")
        );
        assert_eq!(driver_label("i915", "").as_deref(), Some("i915"));
        assert_eq!(driver_label("  ", "6.11.0"), None);
        // The driver-currency feed matches Mesa release strings; this must not
        // look like one.
        let label = driver_label("amdgpu", "6.11.11-valve").unwrap();
        assert!(!label.to_ascii_lowercase().contains("mesa"));
    }

    #[test]
    fn nvidia_exposing_no_vram_total_omits_the_field_instead_of_sending_zero() {
        assert_eq!(vram_total_mb("17163091968\n"), Some(16368.0));
        // A VRAM total of 0 would make the vram-saturation rule read every
        // capture as over capacity.
        assert_eq!(vram_total_mb("0"), None);
        assert_eq!(vram_total_mb(""), None);
        assert_eq!(vram_total_mb("not-a-number"), None);
    }

    #[test]
    fn the_preferred_mode_is_the_first_line_of_the_connectors_mode_list() {
        assert_eq!(
            preferred_mode("2560x1440\n1920x1080\n1280x720\n").as_deref(),
            Some("2560x1440")
        );
        // The Deck's panel.
        assert_eq!(preferred_mode("1280x800\n").as_deref(), Some("1280x800"));
        // An interlace suffix is a mode marker, not part of the height.
        assert_eq!(preferred_mode("1920x1080i\n").as_deref(), Some("1920x1080"));
        assert_eq!(preferred_mode("\n"), None);
        assert_eq!(preferred_mode("garbage\n"), None);
    }

    // ── Assembly ────────────────────────────────────────────────────────────

    fn facts() -> LinuxFacts {
        LinuxFacts {
            vendor_id: crate::driver::VENDOR_AMD,
            cpuinfo: CPUINFO.into(),
            meminfo: MEMINFO.into(),
            os_release: OS_RELEASE.into(),
            kernel: "6.11.11-valve".into(),
            driver_module: Some("amdgpu".into()),
            vram_total: Some("17163091968".into()),
            resolution: Some("2560x1440".into()),
        }
    }

    #[test]
    fn assembles_the_fields_the_capture_cannot_supply() {
        let snapshot = build_snapshot(facts());
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["cpu"], "AMD Ryzen 7 9800X3D 8-Core Processor");
        assert_eq!(json["gpuVendor"], "amd");
        assert_eq!(json["os"], "SteamOS 3.7.13 (kernel 6.11.11-valve)");
        assert_eq!(json["gpuVramTotalMb"], 16368.0);
        assert_eq!(json["resolution"], "2560x1440");
        assert_eq!(json["ramGb"], 31.2);
    }

    #[test]
    fn ram_speed_and_hags_come_back_absent_rather_than_fabricated() {
        // DMI is root-only and HAGS is a Windows concept. Both must be missing,
        // NOT zero and NOT false: the ram-below-rated rule (§15.3) has to
        // self-suppress, and a declared `hags: disabled` would be a claim about
        // a setting that does not exist on this platform.
        let snapshot = build_snapshot(facts());
        assert_eq!(snapshot.ram_speed_mtps, None);
        assert_eq!(snapshot.ram_rated_speed_mtps, None);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert!(json.get("ramSpeedMtps").is_none());
        assert!(json.get("ramRatedSpeedMtps").is_none());

        let (_, methodology) = collect_hardware();
        assert_eq!(methodology.hags, None);
        let json = serde_json::to_value(&methodology).unwrap();
        assert!(json.get("hags").is_none());
    }

    #[test]
    fn this_module_never_names_the_gpu_and_leaves_it_for_mangohud() {
        // Naming a PCI device needs a hardware database we do not ship. The
        // placeholder survives the schema and MangoHud's sysinfo row replaces
        // it; `amdgpu 0x7550` would be a fabrication.
        let snapshot = build_snapshot(facts());
        assert_eq!(snapshot.gpu, "Unknown GPU");
    }

    #[test]
    fn an_unreadable_machine_still_satisfies_the_two_required_fields() {
        let snapshot = build_snapshot(LinuxFacts {
            vendor_id: 0,
            cpuinfo: String::new(),
            meminfo: String::new(),
            os_release: String::new(),
            kernel: String::new(),
            driver_module: None,
            vram_total: None,
            resolution: None,
        });
        assert_eq!(snapshot.gpu, "Unknown GPU");
        assert_eq!(snapshot.cpu, "Unknown CPU");
        assert_eq!(snapshot.gpu_vendor.as_deref(), Some("unknown"));
        let json = serde_json::to_value(&snapshot).unwrap();
        assert!(json.get("gpuDriver").is_none());
        assert!(json.get("gpuVramTotalMb").is_none());
        assert!(json.get("resolution").is_none());
        assert!(json.get("os").is_none());
    }

    #[test]
    fn collection_never_panics_and_always_fills_the_required_fields() {
        let (snapshot, facts) = collect_hardware();
        assert!(!snapshot.gpu.is_empty());
        assert!(!snapshot.cpu.is_empty());
        assert!(facts.capture_tool.starts_with("MangoHud"));
    }
}
