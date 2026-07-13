-- Phase 6 diagnostics: reconcile the table shape with the `Diagnostic` type and
-- add VRAM-capacity storage on runs (§15).
--
-- 0002 shipped `diagnostics.message`, but the domain/DTO shape is `title` +
-- `detail` (a bold headline and a plain-English body). Preserve legacy text if
-- a database already has diagnostics, then derive the new title from its rule
-- code.
--
-- 1. Reconcile diagnostics(message) → (title, detail).
alter table diagnostics rename column message to detail;
alter table diagnostics add column title text;

update diagnostics
   set title = initcap(replace(code, '-', ' '))
 where title is null;

alter table diagnostics alter column title set not null;

-- 2. Total dedicated VRAM (MB), best-effort from the parsers — drives §15.1.
alter table runs add column gpu_vram_total_mb double precision;
