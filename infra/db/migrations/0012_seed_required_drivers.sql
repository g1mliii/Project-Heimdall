-- Curated minimum GPU drivers for the GPU-driver-outdated rule (§15.4).
--
-- A small, documented launch-title seed. `required_driver` holds the vendor's
-- recommended day-one driver. Migration 0014 stamps the reviewed-at time; the
-- rule self-suppresses when this is missing or that curation becomes stale.
--
-- Provenance is curated-synthetic (mirrors fixtures/README.md): representative
-- launch-driver versions, refreshed as a real curation list lands. Slugs match
-- `slugifyGameName` so a run finalized under these titles resolves to these rows.
--
-- Idempotent: upsert on the unique slug so re-running (or a game row created at
-- runtime first) ends with the curated driver set.

insert into games (slug, name, required_driver) values
  ('cyberpunk-2077',         'Cyberpunk 2077',          '566.36'),
  ('alan-wake-2',            'Alan Wake 2',             '565.90'),
  ('hogwarts-legacy',        'Hogwarts Legacy',         '528.24'),
  ('starfield',              'Starfield',               '537.13'),
  ('the-last-of-us-part-i',  'The Last of Us Part I',   '531.61')
on conflict (slug) do update
  set required_driver = excluded.required_driver;
