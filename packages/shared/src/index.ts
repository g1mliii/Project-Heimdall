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
export * from "./capability";
export * from "./graphics-api";
export * from "./methodology";
export * from "./methodology-options";
export * from "./api-errors";
export * from "./eligibility";
export * from "./statistics";
export * from "./assessment";
export * from "./stream";

export { PHYSICS, reconcileGeneratedFrameTech } from "./integrity";
export {
  RUN_VISIBILITY,
  RUN_STATUS,
  RUN_TERMINAL_STATUSES,
  isAggregateEligible,
  aggregateEligibilitySql,
  writableRunStatusSql,
  isVerifiedReviewer,
  verifiedReviewerSql,
} from "./visibility";
