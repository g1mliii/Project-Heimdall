-- Validate Phase 8 constraints after 0036 began enforcing them for new rows.
-- VALIDATE scans existing rows but does not block ordinary reads or writes;
-- migrate.mjs still fails fast if it cannot obtain the required DDL lock.

alter table verifications validate constraint verifications_verified_by_fkey;
alter table reports validate constraint reports_subject_matches_type_check;
alter table runs validate constraint runs_private_owner_check;
