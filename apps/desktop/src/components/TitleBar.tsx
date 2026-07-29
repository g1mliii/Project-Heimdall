/**
 * Custom 38px window chrome (§22.4). The window is `decorations: false`, so
 * drag and the three controls are ours; `data-tauri-drag-region` is Tauri 2's
 * replacement for the kit's `-webkit-app-region: drag`.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinusIcon, SquareIcon, XIcon } from "./icons";

export function TitleBar() {
  const window = getCurrentWindow();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar__name" data-tauri-drag-region>
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path
            d="M16 4.5H32L43.5 16V32L32 43.5H16L4.5 32V16L16 4.5Z"
            stroke="var(--brand-teal)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path
            d="M11 27.5L17 27.5L20.5 20L24 31L27.5 14.5L31 27.5L37 27.5"
            stroke="var(--tier-p01)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Heimdall Capture
      </span>
      <span className="winctl">
        <button type="button" aria-label="Minimize" onClick={() => void window.minimize()}>
          <MinusIcon size={14} />
        </button>
        <button type="button" aria-label="Maximize" onClick={() => void window.toggleMaximize()}>
          <SquareIcon size={12} />
        </button>
        {/* Close hides to tray so the capture hotkey stays live in-game; Quit
            is on the tray menu. */}
        <button
          type="button"
          className="winctl__close"
          aria-label="Close"
          onClick={() => void window.hide()}
        >
          <XIcon size={14} />
        </button>
      </span>
    </div>
  );
}
