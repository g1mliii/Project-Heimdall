/**
 * Display formatters and label maps shared across screens, so the same value
 * never renders two different ways on two pages.
 *
 * Dates are pinned to a fixed locale AND timezone on purpose: Client
 * Components render on the server before hydration, and `toLocaleDateString()`
 * with no args reads the runtime's locale — which differs between the server
 * and a browser. Dev mode surfaces that mismatch as a hydration error.
 */

import type { ReportRow, RunVisibility } from "@heimdall/shared";

export const MEDIUM_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export const VISIBILITY_LABELS: Record<RunVisibility, string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};

export const REPORT_REASON_LABELS: Record<ReportRow["reason"], string> = {
  "abusive-name": "Abusive name",
  "bad-faith-upload": "Bad-faith upload",
  other: "Other",
};
