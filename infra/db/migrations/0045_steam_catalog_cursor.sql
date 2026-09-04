-- Phase 8.7.8 — resumable cursor for the bulk catalog seed.
--
-- `IStoreService/GetAppList` pages through Steam's whole catalog with a
-- `last_appid` cursor. A daily Worker invocation cannot drain that in one run
-- and must not restart from the beginning each time, so the cursor is state,
-- and state belongs in the database rather than in a Worker that is
-- reconstructed from nothing on every trigger.
--
-- Deliberately a keyed table rather than a single row: the same shape serves
-- the next paged upstream without another migration. `steam_pics_cursor`
-- (0042) stays separate — it tracks a PICS changenumber, which is a different
-- kind of position with a different failure mode.

create table if not exists steam_catalog_cursor (
  name        text primary key,
  last_appid  bigint not null default 0
              constraint steam_catalog_cursor_appid_check check (last_appid >= 0),
  -- Null until a full pass completes. Readers use it to tell "we have never
  -- finished a sweep" from "the catalog is fully seeded and this is a refresh".
  completed_at timestamptz,
  updated_at  timestamptz not null default now()
);
