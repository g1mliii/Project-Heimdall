-- Phase 6.5 §16a.3/§16a.4 + §16b.2 — capability manifest storage and richer
-- per-finding diagnostics evidence.
--
-- Numbering note: 0014 is intentionally absent (0013 → 0015 in the tree). The
-- runner tracks applied files by filename and never backfills out of order, so
-- this goes forward-only from 0016. Additive + idempotent by convention: every
-- statement is `add column`, relying on the schema_migrations skip on re-run.
--
-- INVARIANT: the capability + methodology manifests are DERIVED ROLLUP metadata
-- → Postgres. Per-frame data stays Parquet in R2 (§4.3). The manifest inherits
-- the run's privacy/deletion rules automatically: it lives on `runs`, so it
-- cascades on run delete via the existing FKs — no new cascade wiring needed.

-- 1. Per-run capability manifest (§16a.3). The full manifest is jsonb (source of
--    truth, incl. the explicit VRAM-capacity state, §16a.4); the version is a
--    dedicated column so a reprocess pass can find manifests derived under an
--    older shape without parsing every blob.
alter table runs add column capability_manifest jsonb;
alter table runs add column capability_manifest_version integer;

-- 2. Richer per-finding diagnostics (§16b.2): the concrete evidence a finding
--    fired on, the rule version that produced it, and its confidence label.
--    All nullable — Phase 6 findings (and any pre-6.5 rows) carry none, which is
--    exactly the regression-safe default.
alter table diagnostics add column evidence jsonb;
alter table diagnostics add column rule_version text;
alter table diagnostics add column confidence text
  constraint diagnostics_confidence_check
  check (confidence is null or confidence in ('high', 'medium', 'low'));
