-- Hardware aliases are resolved within a CPU/GPU kind, so one source's
-- normalized label must be able to name one CPU and one GPU independently.
-- Persisting that discriminator lets the unique key reject ambiguous aliases
-- within a kind instead of merely accepting a different hardware id.

alter table hardware_aliases
  add column if not exists kind text;

-- Backfill every existing alias from its referenced hardware row before making
-- the discriminator mandatory. The FK guarantees each alias has a target.
update hardware_aliases ha
   set kind = h.kind
  from hardware h
 where h.id = ha.hardware_id
   and ha.kind is distinct from h.kind;

alter table hardware_aliases
  alter column kind set not null;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_kind_check;

alter table hardware_aliases
  add constraint hardware_aliases_kind_check
  check (kind in ('gpu', 'cpu'));

-- PostgreSQL requires a unique key on the full referenced column list before
-- an alias can use a composite foreign key. This also makes it impossible for
-- an alias to claim a kind different from its hardware row.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'hardware'::regclass
       and conname = 'hardware_id_kind_key'
  ) then
    alter table hardware
      add constraint hardware_id_kind_key unique (id, kind);
  end if;
end $$;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_hardware_id_fkey;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_hardware_id_kind_fkey;

alter table hardware_aliases
  add constraint hardware_aliases_hardware_id_kind_fkey
  foreign key (hardware_id, kind)
  references hardware (id, kind)
  on delete cascade;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_source_normalized_name_key;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_source_normalized_name_hardware_id_key;

alter table hardware_aliases
  drop constraint if exists hardware_aliases_source_normalized_name_kind_key;

alter table hardware_aliases
  add constraint hardware_aliases_source_normalized_name_kind_key
  unique (source, normalized_name, kind);
