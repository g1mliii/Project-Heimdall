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
    live.push(["Application,ProcessID", "game.exe,1"]);
    expect(live.unreadable()).toBe(true);
    expect(live.window()).toEqual([]);
    expect(live.averageFps()).toBeNull();
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
