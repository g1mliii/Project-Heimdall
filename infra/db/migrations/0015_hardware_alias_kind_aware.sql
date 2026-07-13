-- Hardware aliases are resolved within a CPU/GPU kind, so one source's
-- normalized label must be able to name one CPU and one GPU independently.
-- Persisting that discriminator lets the unique key reject ambiguous aliases
-- within a kind instead of merely accepting a different hardware id.

alter table hardware_aliases
  add column kind text;

-- Backfill every existing alias from its referenced hardware row before making
-- the discriminator mandatory. The FK guarantees each alias has a target.
update hardware_aliases ha
   set kind = h.kind
 from hardware h
 where h.id = ha.hardware_id;

alter table hardware_aliases
  alter column kind set not null;

-- PostgreSQL requires a unique key on the full referenced column list before
-- an alias can use a composite foreign key. This also makes it impossible for
-- an alias to claim a kind different from its hardware row.
alter table hardware
  add constraint hardware_id_kind_key unique (id, kind);

alter table hardware_aliases
  drop constraint hardware_aliases_hardware_id_fkey,
  drop constraint hardware_aliases_source_normalized_name_key,
  add constraint hardware_aliases_hardware_id_kind_fkey
  foreign key (hardware_id, kind)
  references hardware (id, kind)
  on delete cascade,
  add constraint hardware_aliases_source_normalized_name_kind_key
  unique (source, normalized_name, kind);
