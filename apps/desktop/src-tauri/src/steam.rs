//! Local Steam build identity (§8.8a).
//!
//! `gameBuild` in the methodology profile is a free-text claim the uploader
//! types. A buildid is an observed fact: Steam writes
//! `steamapps/appmanifest_<appid>.acf` on this machine, and it names the exact
//! build installed. The client is already on that machine at capture time, so
//! reading it costs one file read and no network.
//!
//! That is what turns "these two runs differ by 6 FPS" into "these two runs are
//! on different builds and are not comparable" (§25–§26). The two values stay
//! separate: one is declared, the other observed, and the observation never
//! overwrites the declaration.
//!
//! SELF-SUPPRESSING, like every other fact this client collects. A non-Steam
//! game, a pirated copy, a Steam install we cannot find, a platform that will
//! not give us the process path — every one of those yields `None`, and `None`
//! must never degrade a run. There is no fuzzy matching anywhere in this file:
//! an executable is matched to an app by PATH CONTAINMENT or not at all,
//! because a wrong buildid is far worse than a missing one.
//!
//! Both files are VDF, so the parser below is shared. It is deliberately a real
//! (small) tokenizer rather than a regex: `installdir` values contain spaces and
//! backslashes, and Windows paths in `libraryfolders.vdf` are escaped.

use std::path::{Path, PathBuf};

/// A parsed VDF node. Steam's config files are string-or-map, nothing else.
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

impl Vdf {
    /// Case-insensitive child lookup — Steam is inconsistent about key casing
    /// ("UserConfig" vs "userconfig" across versions of the same file).
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Map(entries) => entries
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value),
            Vdf::Str(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(value) => Some(value.as_str()),
            Vdf::Map(_) => None,
        }
    }

    /// Direct children of a map, in file order.
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Map(entries) => entries.as_slice(),
            Vdf::Str(_) => &[],
        }
    }

    fn str_at(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Vdf::as_str)
    }
}

/// Guards against a malformed or hostile file turning into unbounded recursion.
const MAX_DEPTH: usize = 32;

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn skip_trivia(&mut self) {
        loop {
            while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
            // VDF permits `//` line comments between entries.
            if self.bytes[self.pos..].starts_with(b"//") {
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
                    self.pos += 1;
                }
                continue;
            }
            return;
        }
    }

    fn quoted(&mut self) -> Option<String> {
        if self.bytes.get(self.pos) != Some(&b'"') {
            return None;
        }
        self.pos += 1;
        // BYTES, not chars. `byte as char` maps each byte to the code point of
        // the same value, which decodes Steam's UTF-8 files as Latin-1: a
        // library path `D:\Jeux Vidéo\SteamLibrary` came back mojibake'd, its
        // read_dir then failed, and every app in that library disappeared from
        // detection. The input is a `&str`, so the bytes between the quotes are
        // valid UTF-8 and every escape below substitutes ASCII — collecting
        // them and validating once at the close quote is lossless.
        let mut out: Vec<u8> = Vec::new();
        while let Some(&byte) = self.bytes.get(self.pos) {
            self.pos += 1;
            match byte {
                b'"' => return String::from_utf8(out).ok(),
                // `\\` in a Windows path, `\"` in a label. Anything else keeps
                // the backslash: Steam does not escape it and neither do we.
                b'\\' => match self.bytes.get(self.pos) {
                    Some(b'\\') => {
                        out.push(b'\\');
                        self.pos += 1;
                    }
                    Some(b'"') => {
                        out.push(b'"');
                        self.pos += 1;
                    }
                    Some(b'n') => {
                        out.push(b'\n');
                        self.pos += 1;
                    }
                    Some(b't') => {
                        out.push(b'\t');
                        self.pos += 1;
                    }
                    _ => out.push(b'\\'),
                },
                _ => out.push(byte),
            }
        }
        // Unterminated string: the file is truncated, so the parse fails.
        None
    }

    fn value(&mut self, depth: usize) -> Option<Vdf> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.skip_trivia();
        match self.bytes.get(self.pos) {
            Some(b'"') => self.quoted().map(Vdf::Str),
            Some(b'{') => {
                self.pos += 1;
                let mut entries = Vec::new();
                loop {
                    self.skip_trivia();
                    match self.bytes.get(self.pos) {
                        Some(b'}') => {
                            self.pos += 1;
                            return Some(Vdf::Map(entries));
                        }
                        Some(b'"') => {
                            let key = self.quoted()?;
                            let value = self.value(depth + 1)?;
                            entries.push((key, value));
                        }
                        // Anything else inside a map is malformed.
                        _ => return None,
                    }
                }
            }
            _ => None,
        }
    }
}

/// Parse a VDF document into its single root value.
///
/// Returns `None` for anything malformed rather than a partial tree — a half
/// read manifest could otherwise yield a buildid belonging to nothing.
pub fn parse_vdf(input: &str) -> Option<Vdf> {
    let mut scanner = Scanner {
        bytes: input.as_bytes(),
        pos: 0,
    };
    scanner.skip_trivia();
    // The root is `"name" { ... }`; the wrapper key itself carries no meaning.
    let _root_key = scanner.quoted()?;
    scanner.value(0)
}

/// One installed app, as `appmanifest_<appid>.acf` describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledApp {
    pub appid: u32,
    pub name: Option<String>,
    /// Folder under `steamapps/common`, which is how an executable is matched.
    pub installdir: String,
    pub buildid: u64,
    /// `None` means the public branch; `Some` is an opted-in beta.
    pub branch: Option<String>,
}

/// Library roots from `steamapps/libraryfolders.vdf`.
///
/// Every entry is returned, not just the first: a second drive is the normal
/// case, and the captured game is as likely to be there as on the boot volume.
pub fn parse_library_folders(vdf: &str) -> Vec<PathBuf> {
    let Some(root) = parse_vdf(vdf) else {
        return Vec::new();
    };
    root.entries()
        .iter()
        .filter_map(|(_, entry)| entry.str_at("path"))
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Parse one `appmanifest_<appid>.acf`.
///
/// A manifest without a buildid describes an app that is queued or still
/// downloading; it is not a build that was played, so it is rejected.
pub fn parse_app_manifest(acf: &str) -> Option<InstalledApp> {
    let root = parse_vdf(acf)?;
    let appid: u32 = root.str_at("appid")?.trim().parse().ok()?;
    let installdir = root.str_at("installdir")?.trim().to_string();
    if installdir.is_empty() {
        return None;
    }
    let buildid: u64 = root.str_at("buildid")?.trim().parse().ok()?;
    if buildid == 0 {
        return None;
    }
    // The opted-in beta lives under UserConfig (and is mirrored into
    // MountedConfig once the branch is actually installed). Empty means public.
    let branch = ["UserConfig", "MountedConfig"]
        .iter()
        .find_map(|section| root.get(section).and_then(|node| node.str_at("BetaKey")))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Some(InstalledApp {
        appid,
        name: root
            .str_at("name")
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string),
        installdir,
        buildid,
        branch,
    })
}

/// Windows paths compare case-insensitively; Linux paths do not.
const CASE_INSENSITIVE_PATHS: bool = cfg!(windows);

fn normalise(path: &Path, case_insensitive: bool) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let trimmed = text.trim_end_matches('/').to_string();
    if case_insensitive {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed
    }
}

/// Whether `child` lies inside `parent`, comparing whole path segments.
///
/// Segment-aware on purpose: a plain string prefix would match
/// `.../common/Portal 2 Demo` against `.../common/Portal 2`.
pub fn path_contains(parent: &Path, child: &Path, case_insensitive: bool) -> bool {
    let parent = normalise(parent, case_insensitive);
    let child = normalise(child, case_insensitive);
    if parent.is_empty() {
        return false;
    }
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// The app whose install folder contains `executable`, if any.
///
/// Containment only. Nothing here guesses from an executable's NAME, because a
/// wrong appid would attach a real buildid from the wrong game to a run.
pub fn app_for_executable<'a>(
    executable: &Path,
    library: &Path,
    apps: &'a [InstalledApp],
) -> Option<&'a InstalledApp> {
    let common = library.join("steamapps").join("common");
    apps.iter().find(|app| {
        path_contains(
            &common.join(&app.installdir),
            executable,
            CASE_INSENSITIVE_PATHS,
        )
    })
}

/// What the client reports alongside a capture.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamBuild {
    pub appid: u32,
    /// Serialised as a string: a buildid is an identifier, and JSON numbers are
    /// doubles. Nothing downstream should ever do arithmetic on it.
    pub buildid: String,
    pub branch: Option<String>,
    pub app_name: Option<String>,
}

impl From<&InstalledApp> for SteamBuild {
    fn from(app: &InstalledApp) -> Self {
        Self {
            appid: app.appid,
            buildid: app.buildid.to_string(),
            branch: app.branch.clone(),
            app_name: app.name.clone(),
        }
    }
}

/// Read every manifest in one library's `steamapps` folder.
fn apps_in_library(library: &Path) -> Vec<InstalledApp> {
    let steamapps = library.join("steamapps");
    let Ok(entries) = std::fs::read_dir(&steamapps) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("appmanifest_") && name.ends_with(".acf")
        })
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| parse_app_manifest(&text))
        .collect()
}

/// Every library Steam knows about, including the root install itself.
pub fn libraries_for_root(steam_root: &Path) -> Vec<PathBuf> {
    let mut libraries = vec![steam_root.to_path_buf()];
    let manifest = steam_root.join("steamapps").join("libraryfolders.vdf");
    if let Ok(text) = std::fs::read_to_string(&manifest) {
        for path in parse_library_folders(&text) {
            if !libraries.iter().any(|existing| existing == &path) {
                libraries.push(path);
            }
        }
    }
    libraries
}

/// Candidate Steam install roots for this platform.
///
/// Every plausible location is returned rather than one guess: a Linux user may
/// have a native Steam, a Flatpak Steam, or both, and a Windows user may have
/// moved the install off C:.
pub fn steam_root_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    {
        if let Some(path) = windows_registry_steam_path() {
            roots.push(path);
        }
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Ok(base) = std::env::var(var) {
                roots.push(PathBuf::from(base).join("Steam"));
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            roots.push(home.join(".steam").join("steam"));
            roots.push(home.join(".local").join("share").join("Steam"));
            // Flatpak Steam keeps its own tree, and is easy to miss (§23.1
            // hit the same trap with MangoHud configs).
            roots.push(
                home.join(".var")
                    .join("app")
                    .join("com.valvesoftware.Steam")
                    .join("data")
                    .join("Steam"),
            );
        }
    }

    roots.retain(|root| root.is_dir());
    roots
}

#[cfg(windows)]
fn windows_registry_steam_path() -> Option<PathBuf> {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
    };

    let mut key = HKEY::default();
    // SAFETY: `key` is live for the call and closed on every path below.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if opened.is_err() {
        return None;
    }
    let mut buffer = [0u16; 512];
    let mut size = (buffer.len() * 2) as u32;
    let mut kind = REG_SZ;
    // SAFETY: buffer and size are live; size is the byte length of buffer.
    let read = unsafe {
        RegQueryValueExW(
            key,
            w!("SteamPath"),
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr() as *mut u8),
            Some(&mut size),
        )
    };
    // SAFETY: `key` was opened above and is not used again.
    unsafe {
        let _ = RegCloseKey(key);
    }
    if read.is_err() {
        return None;
    }
    let chars = (size as usize / 2).min(buffer.len());
    let text: String = String::from_utf16_lossy(&buffer[..chars])
        .trim_end_matches('\0')
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

/// Full executable path for a running process, or `None` when the platform
/// cannot tell us.
///
/// On Linux the MangoHud watcher reports pid 0 — it sees a log file, not a
/// process (§23.1) — so this yields `None` there and build pinning simply does
/// not apply. That is a stated limitation, not a silent failure.
pub fn executable_for_pid(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }

    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };

        // SAFETY: a failed open returns Err and is handled; the handle is closed
        // on every path below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        // SAFETY: buffer and size are live for the call.
        let ok = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        };
        // SAFETY: the handle came from OpenProcess and is not used again.
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok.ok()?;
        let text = String::from_utf16_lossy(&buffer[..size as usize]);
        return if text.is_empty() {
            None
        } else {
            Some(PathBuf::from(text))
        };
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::fs::read_link(format!("/proc/{pid}/exe")).ok();
    }

    #[allow(unreachable_code)]
    None
}

/// Resolve the Steam build for a captured process.
///
/// Returns `None` for every ordinary non-Steam case, which the caller must
/// treat as normal.
pub fn detect(pid: u32) -> Option<SteamBuild> {
    let executable = executable_for_pid(pid)?;
    for root in steam_root_candidates() {
        for library in libraries_for_root(&root) {
            let apps = apps_in_library(&library);
            if let Some(app) = app_for_executable(&executable, &library, &apps) {
                return Some(SteamBuild::from(app));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARY_FOLDERS: &str = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"contentid"		"123"
		"apps"
		{
			"730"		"12345"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		"games"
	}
}
"#;

    const CS2_MANIFEST: &str = r#"
"AppState"
{
	"appid"		"730"
	"Universe"		"1"
	"name"		"Counter-Strike 2"
	"StateFlags"		"4"
	"installdir"		"Counter-Strike Global Offensive"
	"LastUpdated"		"1787950400"
	"buildid"		"25000182"
	"UserConfig"
	{
		"language"		"english"
	}
	"MountedConfig"
	{
		"language"		"english"
	}
}
"#;

    #[test]
    fn parses_every_library_path_not_just_the_first() {
        let paths = parse_library_folders(LIBRARY_FOLDERS);
        assert_eq!(
            paths,
            vec![
                PathBuf::from(r"C:\Program Files (x86)\Steam"),
                PathBuf::from(r"D:\SteamLibrary"),
            ]
        );
    }

    #[test]
    fn unescapes_windows_backslashes_in_paths() {
        // The file stores `C:\\Program Files`, meaning one literal backslash.
        let paths = parse_library_folders(LIBRARY_FOLDERS);
        assert!(paths[0]
            .to_string_lossy()
            .contains(r"\Program Files (x86)\"));
        assert!(!paths[0].to_string_lossy().contains(r"\\"));
    }

    #[test]
    fn keeps_non_ascii_paths_and_names_intact() {
        // Steam writes .vdf and .acf as UTF-8. Decoding them a byte at a time
        // turned `é` into `Ã©`: the mangled library path's read_dir then failed
        // and every app installed there vanished from detection, while a
        // mangled installdir stopped matching the running executable's path.
        let folders = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"D:\\Jeux Vidéo\\SteamLibrary"
	}
}
"#;
        assert_eq!(
            parse_library_folders(folders),
            vec![PathBuf::from(r"D:\Jeux Vidéo\SteamLibrary")]
        );

        let acf = CS2_MANIFEST.replace("Counter-Strike Global Offensive", "Ōkami HD");
        assert_eq!(parse_app_manifest(&acf).unwrap().installdir, "Ōkami HD");
    }

    #[test]
    fn parses_a_real_manifest() {
        let app = parse_app_manifest(CS2_MANIFEST).expect("manifest parses");
        assert_eq!(app.appid, 730);
        assert_eq!(app.buildid, 25_000_182);
        assert_eq!(app.installdir, "Counter-Strike Global Offensive");
        assert_eq!(app.name.as_deref(), Some("Counter-Strike 2"));
        // No BetaKey means the public branch, not an unknown one.
        assert_eq!(app.branch, None);
    }

    #[test]
    fn reads_an_opted_in_beta_branch() {
        let acf = CS2_MANIFEST.replace(
            r#""UserConfig"
	{
		"language"		"english"
	}"#,
            r#""UserConfig"
	{
		"language"		"english"
		"BetaKey"		"csgo_legacy"
	}"#,
        );
        let app = parse_app_manifest(&acf).expect("manifest parses");
        assert_eq!(app.branch.as_deref(), Some("csgo_legacy"));
    }

    #[test]
    fn treats_an_empty_betakey_as_public() {
        let acf = CS2_MANIFEST.replace(
            r#""language"		"english""#,
            r#""language"		"english"
		"BetaKey"		"""#,
        );
        assert_eq!(parse_app_manifest(&acf).unwrap().branch, None);
    }

    #[test]
    fn rejects_a_manifest_with_no_build_yet() {
        // A queued or downloading app has no build that was ever played.
        let acf = CS2_MANIFEST.replace(r#""buildid"		"25000182""#, r#""buildid"		"0""#);
        assert_eq!(parse_app_manifest(&acf), None);
        let missing = CS2_MANIFEST.replace(r#""buildid"		"25000182""#, "");
        assert_eq!(parse_app_manifest(&missing), None);
    }

    #[test]
    fn rejects_malformed_input_rather_than_half_parsing_it() {
        for text in ["", "{}", "\"AppState\"", "\"AppState\" {", "not vdf at all"] {
            assert_eq!(parse_app_manifest(text), None, "should reject {text:?}");
        }
    }

    #[test]
    fn survives_deeply_nested_input_without_recursing_forever() {
        let deep = format!("\"root\"{}{}", "{ \"k\" ".repeat(200), "}".repeat(200));
        assert_eq!(parse_vdf(&deep), None);
    }

    #[test]
    fn ignores_line_comments() {
        let acf = "\"AppState\"\n{\n// a comment\n\"appid\" \"1\"\n\"installdir\" \"X\"\n\"buildid\" \"2\"\n}";
        let app = parse_app_manifest(acf).expect("parses");
        assert_eq!((app.appid, app.buildid), (1, 2));
    }

    fn app(installdir: &str) -> InstalledApp {
        InstalledApp {
            appid: 730,
            name: None,
            installdir: installdir.to_string(),
            buildid: 1,
            branch: None,
        }
    }

    #[test]
    fn matches_an_executable_inside_the_install_folder() {
        let apps = vec![app("Counter-Strike Global Offensive")];
        let found = app_for_executable(
            Path::new(
                "D:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive/game/bin/cs2.exe",
            ),
            Path::new("D:/SteamLibrary"),
            &apps,
        );
        assert_eq!(found.map(|a| a.appid), Some(730));
    }

    #[test]
    fn does_not_match_a_different_library() {
        let apps = vec![app("Counter-Strike Global Offensive")];
        let found = app_for_executable(
            Path::new("D:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive/cs2.exe"),
            Path::new("E:/OtherLibrary"),
            &apps,
        );
        assert_eq!(found, None);
    }

    #[test]
    fn does_not_match_a_sibling_folder_sharing_a_name_prefix() {
        // The bug a plain string prefix would introduce.
        let apps = vec![app("Portal 2")];
        let found = app_for_executable(
            Path::new("D:/SteamLibrary/steamapps/common/Portal 2 Demo/portal2.exe"),
            Path::new("D:/SteamLibrary"),
            &apps,
        );
        assert_eq!(found, None);
    }

    #[test]
    fn path_containment_is_segment_aware_in_both_case_modes() {
        let parent = Path::new("/games/steamapps/common/Rust");
        assert!(path_contains(
            parent,
            Path::new("/games/steamapps/common/Rust/rust.x86"),
            false
        ));
        assert!(!path_contains(
            parent,
            Path::new("/games/steamapps/common/RustDedicated/x"),
            false
        ));
        // Windows-style comparison ignores case and separator direction.
        assert!(path_contains(
            Path::new(r"D:\SteamLibrary\steamapps\common\Rust"),
            Path::new("d:/steamlibrary/steamapps/common/rust/rust.exe"),
            true,
        ));
        assert!(!path_contains(
            Path::new(r"D:\SteamLibrary\steamapps\common\Rust"),
            Path::new("d:/steamlibrary/steamapps/common/rust/rust.exe"),
            false,
        ));
    }

    #[test]
    fn a_zero_pid_never_resolves() {
        // The Linux watcher reports pid 0; build pinning does not apply there.
        assert_eq!(executable_for_pid(0), None);
    }

    #[test]
    fn serialises_the_buildid_as_a_string() {
        let build = SteamBuild::from(&InstalledApp {
            appid: 730,
            name: Some("Counter-Strike 2".into()),
            installdir: "x".into(),
            buildid: 25_000_182,
            branch: None,
        });
        let json = serde_json::to_string(&build).expect("serialises");
        assert!(json.contains("\"buildid\":\"25000182\""), "{json}");
        assert!(json.contains("\"appName\":\"Counter-Strike 2\""), "{json}");
    }
}
