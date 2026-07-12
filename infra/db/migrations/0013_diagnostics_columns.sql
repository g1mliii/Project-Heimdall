-- Phase 6 diagnostics: reconcile the table shape with the `Diagnostic` type and
-- add VRAM-capacity storage on runs (§15).
--
-- 0002 shipped `diagnostics.message`, but the domain/DTO shape is `title` +
-- `detail` (a bold headline and a plain-English body). The rules engine has
-- never run, so the table is empty in every environment — renaming `message` to
-- `detail` and adding `title` is a safe, data-free reshape.
--
-- Idempotent: guarded so a re-run (or a fresh DB where the reshape already
-- happened) is a no-op.

-- 1. Reconcile diagnostics(message) → (title, detail).
alter table diagnostics add column if not exists title text not null default '';

do $$
begin
  if exists (
        select 1 from information_schema.columns
         where table_name = 'diagnostics' and column_name = 'message'
      ) and not exists (
        select 1 from information_schema.columns
         where table_name = 'diagnostics' and column_name = 'detail'
      ) then
    alter table diagnostics rename column message to detail;
  end if;
end $$;

alter table diagnostics add column if not exists detail text not null default '';

-- 2. Total dedicated VRAM (MB), best-effort from the parsers — drives §15.1.
alter table runs add column if not exists gpu_vram_total_mb double precision;
