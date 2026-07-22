-- Moderation reports (Phase 8 §20.5). Anonymous-allowed: `POST /api/reports`
-- needs no session, matching every other ingest/report path's zero-auth-
-- friction invariant. `reporter_user_id` is nullable + `on delete set null`
-- so an anonymous report, or a later account deletion, never blocks a report
-- from existing as moderation history.

create table if not exists reports (
  id              bigint generated always as identity primary key,
  subject_type    text not null
                  constraint reports_subject_type_check
                  check (subject_type in ('run', 'game')),
  -- Polymorphic on purpose (run id is text, game id is bigint) — only one of
  -- the two is ever set, enforced below. No FK: a reported run/game may be
  -- deleted independently of its report history, which must survive as an
  -- audit trail.
  subject_run_id  text,
  subject_game_id bigint,
  reason          text not null
                  constraint reports_reason_check
                  check (reason in ('abusive-name', 'bad-faith-upload', 'other')),
  detail          text,
  reporter_user_id text references users (id) on delete set null,
  status          text not null default 'open'
                  constraint reports_status_check
                  check (status in ('open', 'resolved', 'dismissed')),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     text references users (id) on delete set null,
  constraint reports_subject_exactly_one check (
    (subject_run_id is not null and subject_game_id is null)
    or (subject_run_id is null and subject_game_id is not null)
  )
);

-- The admin queue reads open reports newest-first; this is its only access path.
create index if not exists reports_open_idx
  on reports (created_at desc, id desc)
  where status = 'open';
