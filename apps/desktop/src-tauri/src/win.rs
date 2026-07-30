//! Windows system access (§21.2, §22.2): foreground process, DXGI adapter,
//! registry, WMI, display mode, group membership, anti-cheat modules.
//!
//! This is the only module with `unsafe` in it. Everything decidable without a
//! syscall lives in `hardware.rs` / `driver.rs` and is unit-tested there; what
//! remains here is the thinnest possible wrapper that turns a Win32 call into a
//! plain Rust value. Every function degrades to `None` rather than failing the
//! app: a machine that will not answer one question must still be able to
//! capture.

use crate::error::{AppError, AppResult};
// `MemoryModule` is only reachable through WMI, so the non-Windows stub has no
// use for it.
#[cfg_attr(not(windows), allow(unused_imports))]
use crate::hardware::{self, HardwareSnapshot, MemoryModule, MethodologyFacts};
use crate::presentmon::capture_tool;
use crate::stream::CaptureTarget;

/// Anti-cheat module base names, lowercased (§24.4). Advisory only — detection
/// never blocks a capture, it only tells the user why PresentMon might behave
/// oddly under a kernel driver that dislikes ETW consumers.
const ANTI_CHEAT_MODULES: &[(&str, &str)] = &[
    ("easyanticheat", "Easy Anti-Cheat"),
    ("eac_launcher", "Easy Anti-Cheat"),
    ("beclient", "BattlEye"),
    ("beservice", "BattlEye"),
];

type AdapterDriverEntry = (String, Option<String>, Option<String>);

fn matching_adapter_driver(
    description: &str,
    entries: impl IntoIterator<Item = AdapterDriverEntry>,
) -> (Option<String>, Option<String>) {
    let wanted = description.trim().to_ascii_lowercase();
    entries
        .into_iter()
        .find(|(candidate, _, _)| candidate.trim().to_ascii_lowercase() == wanted)
        .map(|(_, driver, radeon)| (driver, radeon))
        // Driver facts are diagnostics inputs. An unknown match must stay
        // unknown rather than borrowing a plausible value from another GPU.
        .unwrap_or((None, None))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, MAX_PATH};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplaySettingsW, GetMonitorInfoW, MonitorFromWindow, DEVMODEW, ENUM_CURRENT_SETTINGS,
        MONITORINFOEXW, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::Security::{
        CheckTokenMembership, CreateWellKnownSid, WinBuiltinPerfLoggingUsersSid, PSID,
    };
    use windows::Win32::System::ProcessStatus::{
        EnumProcessModulesEx, GetModuleBaseNameW, LIST_MODULES_ALL,
    };
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
    };

    /// NUL-terminated UTF-16, for the `*W` Win32 entry points. `pub(crate)`
    /// because this module is the one place Win32 wrapping lives — see the
    /// module header — and `gpu_telemetry`'s PDH calls need the same encoding.
    pub(crate) fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn from_wide_nul(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    /// Handle guard: every early return in this module would otherwise leak.
    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                // SAFETY: the handle came from OpenProcess and is closed once.
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    // ── Foreground game ─────────────────────────────────────────────────────

    pub fn foreground_target() -> AppResult<CaptureTarget> {
        // SAFETY: GetForegroundWindow takes no arguments and returns a window
        // handle or null; both are checked.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return Err(AppError::Foreground(
                "no window is in the foreground".into(),
            ));
        }
        let mut pid = 0u32;
        // SAFETY: `pid` is a live local for the duration of the call.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return Err(AppError::Foreground(
                "the foreground window has no owning process".into(),
            ));
        }
        let process = process_name(pid)
            .ok_or_else(|| AppError::Foreground(format!("process {pid} could not be opened")))?;
        Ok(CaptureTarget { pid, process })
    }

    fn open_process(pid: u32) -> Option<OwnedHandle> {
        // Least privilege that still reads a name and a module list. A game
        // running elevated is simply not readable from a per-user client, and
        // that is reported rather than escalated.
        // SAFETY: flags and pid are plain values; the result is checked.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                false,
                pid,
            )
        }
        .ok()?;
        (!handle.is_invalid()).then_some(OwnedHandle(handle))
    }

    struct WindowSearch {
        pid: u32,
        hwnd: HWND,
    }

    unsafe extern "system" fn find_process_window(hwnd: HWND, state: LPARAM) -> BOOL {
        // SAFETY: `window_for_pid` passes a live WindowSearch pointer for the
        // synchronous duration of EnumWindows.
        let search = unsafe { &mut *(state.0 as *mut WindowSearch) };
        let mut pid = 0u32;
        // SAFETY: pid is live and hwnd was supplied by EnumWindows.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        // SAFETY: hwnd was supplied by EnumWindows and remains live here.
        if pid == search.pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
            search.hwnd = hwnd;
            return BOOL(0);
        }
        BOOL(1)
    }

    fn window_for_pid(pid: u32) -> Option<HWND> {
        let mut search = WindowSearch {
            pid,
            hwnd: HWND::default(),
        };
        // SAFETY: the callback is synchronous and receives the live search
        // pointer as LPARAM. Returning FALSE after a match is expected and may
        // make EnumWindows report an error, so its Result is intentionally
        // ignored; the output handle decides success.
        let _ = unsafe {
            EnumWindows(
                Some(find_process_window),
                LPARAM((&mut search as *mut WindowSearch) as isize),
            )
        };
        (!search.hwnd.is_invalid()).then_some(search.hwnd)
    }

    fn process_name(pid: u32) -> Option<String> {
        let handle = open_process(pid)?;
        let mut buffer = [0u16; MAX_PATH as usize];
        // SAFETY: buffer outlives the call and its length is passed correctly.
        let written = unsafe { GetModuleBaseNameW(handle.0, None, &mut buffer) };
        (written > 0).then(|| from_wide_nul(&buffer[..written as usize]))
    }

    /// Anti-cheat loaded into the target process (§24.4). Advisory only.
    pub fn detect_anti_cheat(pid: u32) -> Option<String> {
        let handle = open_process(pid)?;
        let mut modules = vec![Default::default(); 1024];
        let mut needed = 0u32;
        // SAFETY: the slice and `needed` are live; the byte length is derived
        // from the slice itself.
        let ok = unsafe {
            EnumProcessModulesEx(
                handle.0,
                modules.as_mut_ptr(),
                (std::mem::size_of_val(modules.as_slice())) as u32,
                &mut needed,
                LIST_MODULES_ALL,
            )
        };
        if ok.is_err() {
            return None;
        }
        let count = (needed as usize / std::mem::size_of::<windows::Win32::Foundation::HMODULE>())
            .min(modules.len());
        for module in &modules[..count] {
            let mut name = [0u16; MAX_PATH as usize];
            // SAFETY: `name` outlives the call.
            let written = unsafe { GetModuleBaseNameW(handle.0, Some(*module), &mut name) };
            if written == 0 {
                continue;
            }
            let base = from_wide_nul(&name[..written as usize]).to_ascii_lowercase();
            if let Some((_, label)) = ANTI_CHEAT_MODULES
                .iter()
                .find(|(needle, _)| base.contains(needle))
            {
                return Some((*label).to_string());
            }
        }
        None
    }

    // ── Performance Log Users ───────────────────────────────────────────────

    /// Whether the current token is in the built-in Performance Log Users
    /// group, which is what lets PresentMon open an ETW session without
    /// elevation. Drives the onboarding checklist (§22.4).
    pub fn in_performance_log_users() -> Option<bool> {
        let mut sid = [0u8; 68];
        let mut size = sid.len() as u32;
        // SAFETY: the buffer is sized to the documented maximum SID length and
        // its capacity is passed by pointer.
        let created = unsafe {
            CreateWellKnownSid(
                WinBuiltinPerfLoggingUsersSid,
                None,
                Some(PSID(sid.as_mut_ptr().cast())),
                &mut size,
            )
        };
        if created.is_err() {
            return None;
        }
        let mut member = windows::core::BOOL(0);
        // SAFETY: `None` means "the calling thread's token"; the SID buffer is
        // still live.
        let checked =
            unsafe { CheckTokenMembership(None, PSID(sid.as_mut_ptr().cast()), &mut member) };
        checked.ok().map(|()| member.as_bool())
    }

    // ── Registry ────────────────────────────────────────────────────────────

    fn reg_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
        let subkey = wide(subkey);
        let value = wide(value);
        let mut size = 0u32;
        // SAFETY: a null data pointer with a live size asks for the length.
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
        // SAFETY: the buffer is sized from the query above.
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        let text = from_wide_nul(&buffer);
        (!text.is_empty()).then_some(text)
    }

    fn reg_dword(root: HKEY, subkey: &str, value: &str) -> Option<u32> {
        let subkey = wide(subkey);
        let value = wide(value);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `data` and `size` are live locals of the declared size.
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut data as *mut u32).cast()),
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        Some(data)
    }

    /// `HwSchMode`: hardware-accelerated GPU scheduling (§22.2). Absent on
    /// machines whose driver never wrote it, which reports as unknown.
    pub fn hags() -> Option<bool> {
        hardware::hags_state(reg_dword(
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
            "HwSchMode",
        ))
    }

    /// Display-adapter class key for the adapter whose `DriverDesc` matches the
    /// DXGI description, returning `(DriverVersion, RadeonSoftwareVersion)`.
    ///
    /// Matching by description rather than taking `0000` blindly is what keeps
    /// a laptop's integrated adapter from reporting its driver for the
    /// discrete GPU the game is actually running on.
    fn adapter_driver(description: &str) -> (Option<String>, Option<String>) {
        const CLASS: &str =
            r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
        let mut entries = Vec::new();
        for index in 0..16 {
            let subkey = format!("{CLASS}\\{index:04}");
            let Some(desc) = reg_string(HKEY_LOCAL_MACHINE, &subkey, "DriverDesc") else {
                continue;
            };
            entries.push((
                desc,
                reg_string(HKEY_LOCAL_MACHINE, &subkey, "DriverVersion"),
                reg_string(HKEY_LOCAL_MACHINE, &subkey, "RadeonSoftwareVersion"),
            ));
        }
        matching_adapter_driver(description, entries)
    }

    // ── DXGI ────────────────────────────────────────────────────────────────

    /// `(description, vendor id, dedicated video memory bytes)` for the adapter
    /// driving the captured process's monitor. Adapter 0 is only a fallback for
    /// headless/indirect-display cases.
    ///
    /// `DedicatedVideoMemory` is exact bytes straight from the adapter, which
    /// is why VRAM is declared here rather than inferred from a sensor column.
    fn adapter_for_window(
        hwnd: HWND,
        process_luid: Option<(i32, u32)>,
    ) -> Option<(String, u32, u64)> {
        // SAFETY: CreateDXGIFactory1 returns a checked COM result; the
        // interface is dropped at the end of scope.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        // SAFETY: hwnd is a live top-level window when possible; the API has a
        // documented primary-monitor fallback.
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY) };
        let mut fallback = None;
        for adapter_index in 0.. {
            // SAFETY: enumeration ends on the first checked DXGI error.
            let Ok(adapter): Result<IDXGIAdapter1, _> =
                (unsafe { factory.EnumAdapters1(adapter_index) })
            else {
                break;
            };
            // SAFETY: the adapter interface is live for this scope.
            let Ok(desc): Result<DXGI_ADAPTER_DESC1, _> = (unsafe { adapter.GetDesc1() }) else {
                continue;
            };
            let details = (
                from_wide_nul(&desc.Description),
                desc.VendorId,
                desc.DedicatedVideoMemory as u64,
            );
            fallback.get_or_insert_with(|| details.clone());
            if process_luid.is_some_and(|(high, low)| {
                desc.AdapterLuid.HighPart == high && desc.AdapterLuid.LowPart == low
            }) {
                return Some(details);
            }

            for output_index in 0.. {
                // SAFETY: enumeration ends on the first checked DXGI error.
                let Ok(output) = (unsafe { adapter.EnumOutputs(output_index) }) else {
                    break;
                };
                // SAFETY: the output interface is live for this scope.
                let Ok(output_desc) = (unsafe { output.GetDesc() }) else {
                    continue;
                };
                if output_desc.Monitor == monitor {
                    return Some(details);
                }
            }
        }
        fallback
    }

    // ── Display mode ────────────────────────────────────────────────────────

    /// Current mode of the monitor the foreground window is on — not the
    /// primary monitor, which would report the wrong resolution for anyone
    /// gaming on a second display.
    fn resolution_for_window(hwnd: HWND) -> Option<String> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        // SAFETY: MonitorFromWindow always returns a monitor with the
        // DEFAULTTOPRIMARY fallback; `info` is correctly sized above.
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY) };
        // SAFETY: the struct is cast to its base type as the API requires.
        let ok = unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) };
        let device = ok.as_bool().then(|| from_wide_nul(&info.szDevice));

        let mut mode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let name = device.as_deref().map(wide);
        let name_ptr = name
            .as_ref()
            .map(|value| PCWSTR(value.as_ptr()))
            .unwrap_or(PCWSTR::null());
        // SAFETY: `mode` is live and self-describing via dmSize; a null device
        // name means the primary display, which is the intended fallback.
        let read = unsafe { EnumDisplaySettingsW(name_ptr, ENUM_CURRENT_SETTINGS, &mut mode) };
        if !read.as_bool() {
            return None;
        }
        hardware::resolution_label(mode.dmPelsWidth, mode.dmPelsHeight)
    }

    // ── WMI ─────────────────────────────────────────────────────────────────

    // The struct name is what wmi derives the WQL class from, so the rename
    // is load-bearing: without it the query is for a class that does not exist
    // and every field silently comes back empty.
    #[derive(serde::Deserialize)]
    #[serde(rename = "Win32_Processor", rename_all = "PascalCase")]
    struct Win32Processor {
        name: Option<String>,
    }

    // The struct name is what wmi derives the WQL class from, so the rename
    // is load-bearing: without it the query is for a class that does not exist
    // and every field silently comes back empty.
    #[derive(serde::Deserialize)]
    #[serde(rename = "Win32_OperatingSystem", rename_all = "PascalCase")]
    struct Win32OperatingSystem {
        caption: Option<String>,
        build_number: Option<String>,
    }

    // The struct name is what wmi derives the WQL class from, so the rename
    // is load-bearing: without it the query is for a class that does not exist
    // and every field silently comes back empty.
    #[derive(serde::Deserialize)]
    #[serde(rename = "Win32_PhysicalMemory", rename_all = "PascalCase")]
    struct Win32PhysicalMemory {
        capacity: Option<u64>,
        speed: Option<u32>,
        configured_clock_speed: Option<u32>,
    }

    fn wmi_parts() -> (Option<String>, Option<String>, Vec<MemoryModule>) {
        // WMIConnection initializes COM for this thread itself.
        let Ok(connection) = wmi::WMIConnection::new() else {
            return (None, None, Vec::new());
        };

        let cpu = connection
            .query::<Win32Processor>()
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .and_then(|row| row.name);

        let os = connection
            .query::<Win32OperatingSystem>()
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .and_then(|row| {
                hardware::os_label(
                    row.caption.as_deref().unwrap_or_default(),
                    row.build_number.as_deref().unwrap_or_default(),
                )
            });

        let modules = connection
            .query::<Win32PhysicalMemory>()
            .unwrap_or_default()
            .into_iter()
            .map(|row| MemoryModule {
                capacity: row.capacity.unwrap_or(0),
                rated_mtps: row.speed.unwrap_or(0),
                configured_mtps: row.configured_clock_speed.unwrap_or(0),
            })
            .collect();

        (cpu, os, modules)
    }

    // ── Assembly ────────────────────────────────────────────────────────────

    fn collect_hardware_for_window(
        hwnd: HWND,
        process_luid: Option<(i32, u32)>,
    ) -> (HardwareSnapshot, MethodologyFacts) {
        let (description, vendor_id, vram) =
            adapter_for_window(hwnd, process_luid).unwrap_or_default();
        let (internal_driver, radeon) = adapter_driver(&description);
        let (cpu, os, modules) = wmi_parts();

        let snapshot = hardware::build_snapshot(
            &description,
            vendor_id,
            vram,
            internal_driver.as_deref().unwrap_or_default(),
            radeon.as_deref(),
            cpu.as_deref().unwrap_or_default(),
            &modules,
            os,
            resolution_for_window(hwnd),
        );
        let facts = MethodologyFacts {
            hags: hags(),
            capture_tool: capture_tool(),
        };
        (snapshot, facts)
    }

    pub fn collect_hardware() -> (HardwareSnapshot, MethodologyFacts) {
        // SAFETY: a null result is accepted by MonitorFromWindow, which falls
        // back to the primary display.
        collect_hardware_for_window(unsafe { GetForegroundWindow() }, None)
    }

    pub fn collect_hardware_for_pid(pid: u32) -> (HardwareSnapshot, MethodologyFacts) {
        let hwnd = window_for_pid(pid).unwrap_or_else(|| {
            // SAFETY: best-effort fallback when a process has no visible
            // top-level window (or closes it during collection).
            unsafe { GetForegroundWindow() }
        });
        collect_hardware_for_window(hwnd, crate::gpu_telemetry::adapter_luid_for_pid(pid))
    }
}

#[cfg(not(windows))]
mod imp {
    //! Non-Windows stub.
    //!
    //! The client ships for Windows only; this exists so `cargo test`,
    //! `cargo clippy` and editor tooling work on a Linux checkout without
    //! `#[cfg(windows)]` scattered through every caller. It reports "not
    //! available" rather than fabricating plausible hardware.

    use super::*;

    pub fn foreground_target() -> AppResult<CaptureTarget> {
        Err(AppError::Foreground(
            "foreground detection is implemented for Windows only".into(),
        ))
    }

    pub fn detect_anti_cheat(_pid: u32) -> Option<String> {
        None
    }

    pub fn in_performance_log_users() -> Option<bool> {
        None
    }

    pub fn hags() -> Option<bool> {
        None
    }

    pub fn collect_hardware() -> (HardwareSnapshot, MethodologyFacts) {
        (
            hardware::build_snapshot("", 0, 0, "", None, "", &[], None, None),
            MethodologyFacts {
                hags: None,
                capture_tool: capture_tool(),
            },
        )
    }

    pub fn collect_hardware_for_pid(_pid: u32) -> (HardwareSnapshot, MethodologyFacts) {
        collect_hardware()
    }
}

// Mirror image of linux.rs: the stub half keeps a non-Windows checkout building
// and testing, and nothing there calls into it.
#[cfg_attr(not(windows), allow(unused_imports))]
pub use imp::{
    collect_hardware, collect_hardware_for_pid, detect_anti_cheat, foreground_target,
    in_performance_log_users,
};

#[cfg(windows)]
pub(crate) use imp::wide;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anti_cheat_needles_are_lowercase_so_module_matching_is_case_insensitive() {
        for (needle, _) in ANTI_CHEAT_MODULES {
            assert_eq!(*needle, needle.to_ascii_lowercase());
        }
    }

    #[test]
    fn collection_never_panics_and_always_fills_the_required_fields() {
        let (snapshot, facts) = collect_hardware();
        assert!(!snapshot.gpu.is_empty());
        assert!(!snapshot.cpu.is_empty());
        assert!(facts.capture_tool.starts_with("PresentMon "));
    }

    #[test]
    fn an_unmatched_adapter_never_borrows_another_gpus_driver() {
        let entries = vec![
            (
                "Intel(R) Arc(TM) Graphics".to_string(),
                Some("32.0.101.6734".to_string()),
                None,
            ),
            (
                "NVIDIA GeForce RTX 5090".to_string(),
                Some("32.0.15.9012".to_string()),
                None,
            ),
        ];

        assert_eq!(
            matching_adapter_driver("AMD Radeon RX 9070 XT", entries),
            (None, None)
        );
    }

    #[test]
    fn adapter_driver_matching_is_trimmed_and_case_insensitive() {
        let entries = vec![(
            " NVIDIA GeForce RTX 5090 ".to_string(),
            Some("32.0.15.9012".to_string()),
            None,
        )];
        assert_eq!(
            matching_adapter_driver("nvidia geforce rtx 5090", entries),
            (Some("32.0.15.9012".to_string()), None)
        );
    }
}

#[cfg(all(test, windows))]
mod live_probe {
    /// Not an assertion — a `cargo test -- --nocapture live_probe` helper for
    /// eyeballing what this machine actually reports. Ignored by default so it
    /// never gates CI on hardware specifics.
    #[test]
    #[ignore]
    fn print_collected_hardware() {
        let (hardware, facts) = super::collect_hardware();
        println!("{}", serde_json::to_string_pretty(&hardware).unwrap());
        println!("{}", serde_json::to_string_pretty(&facts).unwrap());
        println!("perf log users: {:?}", super::in_performance_log_users());
    }
}
