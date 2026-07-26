-- Phase 8.6 follow-up — known DirectX spelling aliases describe the same
-- rendering API and must not split comparability cohorts that the UI labels
-- identically. Unknown free-text APIs remain untouched.
--
-- Keep both the queryable comparability column and the versioned methodology
-- source JSON in lockstep. The application applies the same canonicalization
-- to all new writes.
--
-- The alias set mirrors GRAPHICS_API_ALIASES in packages/shared/src/graphics-api.ts;
-- a test asserts the two lists agree, so an alias added there fails until a
-- follow-up migration backfills it (this file is frozen once merged).

-- Normalize once per row: Postgres does not fold identical subexpressions, so
-- repeating the regexp in each CASE arm would run it up to five times a row.
with normalized as (
  select id,
         lower(regexp_replace(btrim(graphics_api), '[[:space:]_-]', '', 'g')) as alias
    from runs
   where graphics_api is not null
), canonicalized as (
  select id,
         case
           when alias in ('dx12', 'd3d12', 'directx12') then 'dx12'
           when alias in ('dx11', 'd3d11', 'directx11') then 'dx11'
           when alias in ('vulkan', 'opengl', 'metal') then alias
         end as graphics_api
    from normalized
   where alias in (
     'dx12', 'd3d12', 'directx12',
     'dx11', 'd3d11', 'directx11',
     'vulkan', 'opengl', 'metal'
   )
)
update runs r
   set graphics_api = canonicalized.graphics_api,
       settings_json = case
         when r.methodology_manifest_version is not null
          and r.settings_json ? 'graphicsApi'
           then jsonb_set(
             r.settings_json,
             '{graphicsApi}',
             to_jsonb(canonicalized.graphics_api),
             false
           )
         else r.settings_json
       end
  from canonicalized
 where r.id = canonicalized.id
   and canonicalized.graphics_api is not null
   and (
     r.graphics_api is distinct from canonicalized.graphics_api
     or (
       r.methodology_manifest_version is not null
       and r.settings_json ? 'graphicsApi'
       and r.settings_json ->> 'graphicsApi' is distinct from canonicalized.graphics_api
     )
   );
