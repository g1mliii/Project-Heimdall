import { describe, expect, it } from "vitest";

import { bandThresholdMs, formatTimeTick, formatValueTick, toDisplay } from "./units";

describe("toDisplay", () => {
  it("passes ms through untouched", () => {
    expect(toDisplay(8.3, "ms")).toBe(8.3);
  });

  it("maps ms to FPS via 1000/x", () => {
    expect(toDisplay(10, "fps")).toBe(100);
    expect(toDisplay(16.7, "fps")).toBeCloseTo(59.88, 2);
  });
});

describe("bandThresholdMs", () => {
  it("targets 120 FPS pacing for high-refresh captures", () => {
    expect(bandThresholdMs(100)).toBe(8.3);
    expect(bandThresholdMs(144)).toBe(8.3);
  });

  it("targets 60 FPS pacing otherwise", () => {
    expect(bandThresholdMs(99.9)).toBe(16.7);
    expect(bandThresholdMs(60)).toBe(16.7);
  });
});

describe("tick formatting", () => {
  it("shows one decimal only for small non-integers", () => {
    expect(formatValueTick(8.3)).toBe("8.3");
    expect(formatValueTick(8)).toBe("8");
    expect(formatValueTick(120)).toBe("120");
    expect(formatValueTick(120.4)).toBe("120");
  });

  it("formats capture time as seconds", () => {
    expect(formatTimeTick(0)).toBe("0s");
    expect(formatTimeTick(15_000)).toBe("15s");
    expect(formatTimeTick(7_500)).toBe("7.5s");
  });
});
