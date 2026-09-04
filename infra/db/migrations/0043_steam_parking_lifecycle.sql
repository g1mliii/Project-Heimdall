-- Phase 8.7 fix — make the inactive-app parking pass reachable and reversible.
--
-- 0041 shipped the working-set lifecycle with two defects that only show up
-- over weeks of scheduled runs, which is exactly when nobody is watching.
--
-- 1. THE PARKING PASS COULD NEVER PARK ITS TARGETS. `DEMOTE_INACTIVE_APPS_SQL`
--    would only judge an app that already had a `steam_player_counts` row older
--    than a day — a sound-looking "don't park a brand-new entrant" guard that
--    happened to exempt precisely the class the pass exists to shed. Steam
--    answers `result != 1` for DLC, tools, demos and soundtracks; the players
--    lane writes NO row for those, so the guard was false for them forever and
--    the working set could only grow. `promoted_at` answers the question the
--    guard was actually asking — how long has this app been in the working
--    set — without depending on the app having reported anything.
--
-- 2. TIER 0 WAS ABSORBING. `UPSERT_APPS_SQL` re-seeds with
--    `least(steam_apps.poll_tier, excluded.poll_tier)` so an operator's
--    hand-narrowed tier survives re-discovery. Correct for an operator, wrong
--    for the poller: 0041's own comment promises "an app that takes off is
--    re-promoted by the charts source the moment it charts", and `least()` made
--    that impossible. A title parked during a quiet week and then charting at
--    number one stayed dark, its whole time series silently ended.
--
--    `parked_at` is what separates the two cases. The poller sets it when it
--    parks an app; an operator setting `poll_tier = 0` by hand does not, so a
--    hand-narrowed row keeps the guarantee it always had.
--
-- Both columns are nullable with no backfill, deliberately. Null `promoted_at`
-- means "never re-promoted", and readers coalesce to `first_seen_at`, so every
-- existing row keeps its real tracked-since date rather than being dated to
-- whenever this migration ran (which would exempt the entire catalog from
-- parking for a day). Null `parked_at` means "the poller has not parked this",
-- which is the truth for every row that exists today.

alter table steam_apps add column if not exists parked_at   timestamptz;
alter table steam_apps add column if not exists promoted_at timestamptz;

comment on column steam_apps.parked_at is
  'When the POLLER parked this app at tier 0. Null means it never did: a tier-0 row with a null parked_at is an operator decision and re-discovery must not widen it.';
comment on column steam_apps.promoted_at is
  'Start of the current tracked stretch, set when the charts source re-promotes a parked app. Null means the stretch started at first_seen_at.';
