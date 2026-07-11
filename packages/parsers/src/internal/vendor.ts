/**
 * GPU vendor inference from the raw display string — feeds
 * `HardwareSnapshot.gpuVendor` and the sensor-availability matrix (§7.3).
 */

import type { GpuVendor } from "@heimdall/shared";

export function inferGpuVendor(gpu: string): GpuVendor {
  const text = gpu.toLowerCase();
  if (/nvidia|geforce|\b(rtx|gtx)\b|quadro/.test(text)) return "nvidia";
  if (/\bamd\b|radeon|\brx\b/.test(text)) return "amd";
  if (/intel|\barc\b/.test(text)) return "intel";
  return "unknown";
}
