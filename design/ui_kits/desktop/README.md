# Desktop Capture Client — UI kit

Recreation of Heimdall's **Tauri 2** native capture client (Windows/Linux). A deliberately
tiny window: detect hardware, capture ~60s of frame-time data via bundled Intel PresentMon
(Windows) or a MangoHud watcher (Linux), then sign and upload the result as a shareable run.

> Greenfield note: `apps/desktop` was empty scaffolding (Phase 9+ in `IMPLEMENTATION_PLAN.md`).
> This kit visualizes the planned client, not existing UI code.

## Run it
Open `index.html`. The single window cycles through three live states:
1. **Ready** — detected hardware + the global capture hotkey (Shift + F11). *Start capture.*
2. **Capturing** — elapsed timer + live frame-time trace + running frame count. *Stop & analyze.*
3. **Complete** — smoothness summary tiles, "payload signed" note, *Upload & share* / *Discard*.

(The demo timer is accelerated; production captures ~60s.)

## Files
| File | Purpose |
|---|---|
| `index.html` | Native window chrome + mounts the client |
| `CaptureClient.jsx` | The full three-state capture flow |

Charts are reused from `../web/charts.jsx`. As with the web kit, screens use the `.hd-*`
classes directly for standalone rendering; production should compose the React components.
