-- Freshness guard for Phase 6's hand-curated game-ready driver seed (§15.4).
--
-- The curation timestamp is deliberately separate from the version: changing a
-- value without refreshing it must remain suppressed. Phase 6.6's automated
-- curation service will update both columns on each successful source refresh.

alter table games add column if not exists required_driver_checked_at timestamptz;

-- The Phase 6 seed immediately preceding this migration is the reviewed
-- baseline. Requirements age out in the repository read after 30 days unless a
-- curation pass explicitly refreshes this timestamp.
update games
   set required_driver_checked_at = now()
 where required_driver is not null
   and required_driver_checked_at is null;
