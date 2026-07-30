// Prevents a console window from opening alongside the app on Windows release
// builds. Debug builds keep it: the PresentMon sidecar's stderr goes there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    heimdall_capture_lib::run();
}
