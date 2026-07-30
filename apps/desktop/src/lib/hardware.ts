/**
 * Which hardware source wins, per field (§23.2).
 *
 * `uploadCaptureBytes` merges `options.hardware` OVER the snapshot the parser
 * extracted from the capture itself, because on Windows the capture carries no
 * hardware at all and the client's DXGI/WMI reads are the only source there is.
 *
 * On Linux that order is exactly backwards. MangoHud's sysinfo row is written by
 * the tool that was inside the game: its `gpu` names the adapter that actually
 * rendered, and its `driver` carries the Mesa version string that
 * `docs/driver-currency-curation.md` locks as the Linux driver-currency
 * contract. `linux.rs` reads `/proc` and `/sys` for the things MangoHud omits —
 * VRAM total, resolution, kernel — and would otherwise clobber `Mesa 26.1.4`
 * with a kernel module name, and a real GPU name with `Unknown GPU`.
 *
 * So the rule is: drop from the override any field the capture already supplied.
 * Stated as a general rule rather than a Linux special case, because it is one —
 * a value read from inside the game beats a value read from beside it. It is a
 * no-op on Windows, where PresentMon's CSV has no hardware fields to defer to.
 */

import type { HardwareSnapshot } from "@heimdall/shared";

/**
 * `declared` minus every key `fromCapture` already answers.
 *
 * Only keys with a genuinely present value in `fromCapture` are dropped. An
 * explicit `undefined` is not an answer — deferring to it would delete a field
 * the client did know, leaving the run with neither value.
 */
export function deferToCapture(
  declared: HardwareSnapshot,
  fromCapture: Partial<HardwareSnapshot> | undefined,
): Partial<HardwareSnapshot> {
  if (fromCapture === undefined) return declared;
  const merged: Partial<HardwareSnapshot> = { ...declared };
  for (const key of Object.keys(fromCapture) as (keyof HardwareSnapshot)[]) {
    if (fromCapture[key] !== undefined) delete merged[key];
  }
  return merged;
}
