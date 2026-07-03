-- Canonical dictionaries (PLAN.md §4; IMPLEMENTATION_PLAN §4.1, §4.4).
--
-- Display strings fragment ("RTX 4070" vs "NVIDIA GeForce RTX 4070" vs "… Laptop
-- GPU") and would split one GPU into many buckets. Aggregates group on canonical
-- ids from these tables — never on raw strings. Alias tables absorb the variants;
-- §11.9 match-or-create resolves against them on finalize.
--
-- Enum-ish CHECK values mirror packages/shared/src — keep in lockstep.

create table if not exists users (
  id         text primary key, -- Clerk user id once auth lands (Phase 8)
  handle     text unique,
  email      text,
  role       text not null default 'public'
             constraint users_role_check check (role in ('public', 'verified', 'admin')),
  reputation integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists games (
  id              bigint generated always as identity primary key,
  slug            text not null unique,
  name            text not null,
  engine          text,
  release_date    date,
  -- Curated minimum GPU driver for day-one stability (§15.4). Nullable: the rule
  -- suppresses itself when this is stale/absent rather than firing false positives.
  required_driver text
);

create table if not exists game_aliases (
  id              bigint generated always as identity primary key,
  game_id         bigint not null references games (id) on delete cascade,
  source          text not null, -- capture source / import channel the raw name came from
  raw_name        text not null,
  normalized_name text not null,
  unique (source, normalized_name)
);

create table if not exists hardware (
  id               bigint generated always as identity primary key,
  kind             text not null
                   constraint hardware_kind_check check (kind in ('gpu', 'cpu')),
  vendor           text,
  canonical_name   text not null,
  -- Stable PCI identity (§4.4) — preferred over display names for GPU identity.
  -- Nullable: CPUs and legacy imports may lack them; aliases cover the stragglers.
  pci_vendor_id    text,
  pci_device_id    text,
  pci_subsystem_id text
);

create table if not exists hardware_aliases (
  id              bigint generated always as identity primary key,
  hardware_id     bigint not null references hardware (id) on delete cascade,
  source          text not null,
  raw_name        text not null,
  normalized_name text not null,
  unique (source, normalized_name)
);
