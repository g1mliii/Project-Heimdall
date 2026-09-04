-- Phase 8.7 fix — actually create games_steam_appid_fkey outside the first schema.
--
-- 0041 guards its `add constraint` with
--
--     if not exists (select 1 from pg_constraint where conname = 'games_steam_appid_fkey')
--
-- and `pg_constraint` is DATABASE-wide, not schema-scoped. Constraint names are
-- unique per table, not per database, so the moment any one schema carries the
-- constraint the guard is true everywhere and every other schema silently skips
-- it. 0020 got this right — it qualifies with `conrelid = 'runs'::regclass`,
-- which resolves through search_path to the schema being migrated.
--
-- The visible cost is the test tier: the harness migrates a fresh
-- `heimdall_test_*` schema in a database whose `public` schema already has the
-- constraint, so `games.steam_appid` came up with no foreign key at all and the
-- "nulls the game link rather than deleting the game" case failed locally while
-- passing in CI (a fresh container has only one schema). The same hole would
-- swallow the constraint in any staging or per-tenant schema.
--
-- Reentrant and correct in both directions: a schema that already has the
-- constraint is left alone, and one that does not gets it.

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'games_steam_appid_fkey'
       and conrelid = 'games'::regclass
  ) then
    alter table games
      add constraint games_steam_appid_fkey
      foreign key (steam_appid) references steam_apps (appid) on delete set null;
  end if;
end
$$;
