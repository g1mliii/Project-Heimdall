// @heimdall/parsers — public barrel.
//
// Pure, isomorphic capture-log parsers (CapFrameX / PresentMon / MangoHud) and
// the canonical metric computation. Everything under src/ is dependency-free
// and total over arbitrary input: malformed bytes produce a typed ParseError,
// never a crash. Tests (Node-only) live alongside; fixtures under ../fixtures.

export * from "./errors";
export * from "./version";
export * from "./capframex";
export * from "./presentmon";
export * from "./mangohud";
export * from "./parse";
export * from "./metrics";
export * from "./sensor-availability";
