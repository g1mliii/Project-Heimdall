-- Moderation status (Phase 8 §20.5). `moderated` is distinct from owner-set
-- `private`, integrity-`flagged`, and the deletion tombstone `hidden`: the
-- owner sees it labeled, the public gets a 404 (same visibility gate as
-- `hidden`/`flagged` for a stranger), and it never pools into aggregates —
-- aggregateEligibilitySql already requires status = 'validated', so no
-- change needed there.

alter table runs
  drop constraint if exists runs_status_check,
  add constraint runs_status_check
  check (status in ('pending', 'validated', 'flagged', 'hidden', 'moderated'));
