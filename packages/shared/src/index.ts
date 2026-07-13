// @heimdall/shared — public barrel.
//
// Single source of truth for cross-app types, zod schemas, constants, and test
// fixtures. Each symbol reaches this barrel by exactly one path (no duplicate
// `export *` of the same name): OUTLIER is re-exported via ./constants, PHYSICS
// via ./integrity, the RUN_* values via ./visibility, and the RunVisibility /
// RunStatus *types* via ./types.

export * from "./types";
export * from "./schemas";
export * from "./constants";
export * from "./fixtures";
export * from "./fixtures-frames";
export * from "./tokens";
export * from "./parquet";
export * from "./naming";
export * from "./comparability";
export * from "./methodology";

export { PHYSICS } from "./integrity";
export {
  RUN_VISIBILITY,
  RUN_STATUS,
  isAggregateEligible,
  aggregateEligibilitySql,
} from "./visibility";
