import { describe, expect, it } from "vitest";
import { LiveFrameTimes, LIVE_WINDOW } from "./live-frames";

describe("LiveFrameTimes", () => {
  it("reads the v2 FrameTime column and reports mean FPS", () => {
    const live = new LiveFrameTimes();
    live.push(["Application,ProcessID,FrameTime", "game.exe,1,10", "game.exe,1,10"]);
    expect(live.count()).toBe(2);
    expect(live.averageFps()).toBeCloseTo(100, 6);
  });

  it("reads the v1 MsBetweenPresents column too", () => {
    const live = new LiveFrameTimes();
    live.push(["Application,MsBetweenPresents", "game.exe,20"]);
    expect(live.averageFps()).toBeCloseTo(50, 6);
  });

  it("draws nothing rather than guessing when no frame-time column exists", () => {
    const live = new LiveFrameTimes();
    // Enough rows to exhaust the preamble allowance; the search is bounded so
    // this resolves during the capture rather than at the end of it.
    live.push(["Application,ProcessID", "game.exe,1", "game.exe,2", "game.exe,3", "game.exe,4"]);
    expect(live.unreadable()).toBe(true);
    expect(live.awaitingHeader()).toBe(false);
    expect(live.window()).toEqual([]);
    expect(live.averageFps()).toBeNull();
  });

  it("finds a MangoHud header below the sysinfo rows (§23.1)", () => {
    // A MangoHud log does NOT open with its frame header. Committing to line 0
    // found no frame-time column and blanked the chart for every Linux capture,
    // silently — `unreadable()` is not an error state.
    const live = new LiveFrameTimes();
    live.push([
      "os,cpu,gpu,ram,kernel,driver",
      "SteamOS 3.7.13,AMD Ryzen 7 9800X3D,AMD Radeon RX 9070 XT,32,6.11.11-valve,Mesa 26.1.4",
      "fps,frametime,cpu_load,gpu_load,elapsed",
      "144.7,6.91,42,97,16000000",
      "142.1,7.04,44,98,23000000",
    ]);
    expect(live.unreadable()).toBe(false);
    expect(live.count()).toBe(2);
    expect(live.averageFps()).toBeCloseTo(2000 / 13.95, 6);
  });

  it("reports awaiting-header while only sysinfo rows have arrived", () => {
    // The Capturing screen keys its "the trace appears when it flushes" copy
    // off this rather than rendering an empty chart that looks broken.
    const live = new LiveFrameTimes();
    live.push(["os,cpu,gpu,ram,kernel,driver"]);
    expect(live.awaitingHeader()).toBe(true);
    expect(live.unreadable()).toBe(false);
  });

  it("a sysinfo value row is never mistaken for the header", () => {
    // The sysinfo values are free text and arrive before the real header; if one
    // were accepted, every subsequent frame time would be read out of the wrong
    // column.
    const live = new LiveFrameTimes();
    live.push([
      "os,cpu,gpu",
      "Arch Linux,AMD Ryzen 7 7800X3D,AMD Radeon RX 7900 XTX",
      "fps,frametime",
      "100,10",
    ]);
    expect(live.count()).toBe(1);
    expect(live.averageFps()).toBeCloseTo(100, 6);
  });

  it("skips malformed and non-positive rows instead of counting them as 0 ms", () => {
    const live = new LiveFrameTimes();
    live.push(["Application,FrameTime", "game.exe,10", "game.exe,", "game.exe,0", "game.exe,abc"]);
    expect(live.count()).toBe(1);
    expect(live.averageFps()).toBeCloseTo(100, 6);
  });

  it("bounds the retained window while the running average stays whole-capture", () => {
    const live = new LiveFrameTimes();
    live.push(["Application,FrameTime"]);
    live.push(Array.from({ length: LIVE_WINDOW + 250 }, () => "game.exe,10"));
    expect(live.window()).toHaveLength(LIVE_WINDOW);
    expect(live.count()).toBe(LIVE_WINDOW + 250);
    expect(live.averageFps()).toBeCloseTo(100, 6);
  });

  it("has no average before the first frame arrives", () => {
    const live = new LiveFrameTimes();
    expect(live.averageFps()).toBeNull();
    live.push(["Application,FrameTime"]);
    expect(live.averageFps()).toBeNull();
  });
});
