-- Indexes (IMPLEMENTATION_PLAN §4.2).
--
-- Bias toward the known hot paths rather than broad low-cardinality indexes:
-- public aggregate pages, recency/keyset pagination, worker queue claims, and
-- child FK lookups used by joins/cascades. Starting from zero lets us add these
-- before volume makes backfills expensive.

-- Game-page distributions bucket by game + canonical GPU (§17.1), but only
-- public+validated rows are aggregate-eligible (§4.5). Keeping private,
-- unlisted, pending, and flagged rows out of this index prevents write-heavy
-- ingest traffic from bloating the public distribution path.
create index if not exists runs_game_gpu_idx
  on runs (game_id, gpu_hardware_id, created_at desc, id desc)
  where status = 'validated'
    and visibility = 'public'
    and game_id is not null
    and gpu_hardware_id is not null;

-- Recency listings / neutral submissions-table sort (§17.7). Include id for
-- stable keyset pagination when multiple runs share a timestamp.
create index if not exists runs_created_at_idx
  on runs (created_at desc, id desc);

-- Moderation/admin filters still need the raw lifecycle pair. Ordering by
-- recency keeps status pages off full-table sorts.
create index if not exists runs_status_visibility_idx
  on runs (status, visibility, created_at desc, id desc);

-- Direct object/token lookups stay O(log n) and uniqueness catches accidental
-- R2 key or anonymous-management-token reuse.
create unique index if not exists runs_frames_object_key_idx
  on runs (frames_object_key)
  where frames_object_key is not null;
create unique index if not exists runs_anonymous_management_token_hash_idx
  on runs (anonymous_management_token_hash)
  where anonymous_management_token_hash is not null;

-- Canonical dictionary lookups (§4.4). Case-folded names prevent duplicate
-- "RTX 4070" / "rtx 4070" buckets, while complete GPU PCI identities are
-- unique when all stable IDs are present.
create unique index if not exists hardware_kind_canonical_name_idx
  on hardware (kind, lower(canonical_name));
create unique index if not exists hardware_gpu_pci_identity_idx
  on hardware (pci_vendor_id, pci_device_id, pci_subsystem_id)
  where kind = 'gpu'
    and pci_vendor_id is not null
    and pci_device_id is not null
    and pci_subsystem_id is not null;

-- Child-side FK indexes keep joins and cascading deletes from degrading as the
-- dictionaries, accounts, diagnostics, comparisons, and jobs tables grow.
create index if not exists game_aliases_game_id_idx
  on game_aliases (game_id);
create index if not exists hardware_aliases_hardware_id_idx
  on hardware_aliases (hardware_id);
create index if not exists runs_user_id_idx
  on runs (user_id)
  where user_id is not null;
create index if not exists runs_gpu_hardware_id_idx
  on runs (gpu_hardware_id)
  where gpu_hardware_id is not null;
create index if not exists runs_cpu_hardware_id_idx
  on runs (cpu_hardware_id)
  where cpu_hardware_id is not null;
create index if not exists diagnostics_run_id_idx
  on diagnostics (run_id);
create index if not exists comparisons_user_id_idx
  on comparisons (user_id)
  where user_id is not null;
create index if not exists comparisons_before_run_id_idx
  on comparisons (before_run_id);
create index if not exists comparisons_after_run_id_idx
  on comparisons (after_run_id);
create index if not exists verifications_verified_by_idx
  on verifications (verified_by)
  where verified_by is not null;
create index if not exists verification_jobs_run_id_idx
  on verification_jobs (run_id);

-- Worker claim scan: pending jobs ordered by lock state (§11.5), with created_at
-- and id for deterministic SKIP LOCKED batches.
create index if not exists verification_jobs_status_locked_at_idx
  on verification_jobs (status, locked_at, created_at, id);

-- §11.9 match-or-create resolves raw names through the alias tables.
create index if not exists game_aliases_normalized_name_idx
  on game_aliases (normalized_name);
create index if not exists hardware_aliases_normalized_name_idx
  on hardware_aliases (normalized_name);
