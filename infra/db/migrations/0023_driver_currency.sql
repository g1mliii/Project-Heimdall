-- Phase 6.6: replace the single hand-seeded NVIDIA/Windows column with
-- scheduled, vendor + OS aware currency and game-ready catalogs.

create table driver_catalog (
  vendor          text not null
                  constraint driver_catalog_vendor_check
                  check (vendor in ('nvidia', 'amd', 'intel')),
  os              text not null
                  constraint driver_catalog_os_check
                  check (os in ('windows', 'linux')),
  component       text not null
                  constraint driver_catalog_component_check
                  check (component in ('gpu', 'mesa', 'chipset')),
  gpu_series      text,
  gpu_series_key  text generated always as (coalesce(gpu_series, '')) stored,
  latest_version  text not null,
  released_at     date not null,
  source_url      text not null,
  fetched_at      timestamptz not null,
  primary key (vendor, os, component, gpu_series_key)
);

create table game_driver_requirements (
  game_id      bigint not null references games (id) on delete cascade,
  vendor       text not null
               constraint game_driver_requirements_vendor_check
               check (vendor in ('nvidia', 'amd', 'intel')),
  os           text not null
               constraint game_driver_requirements_os_check
               check (os in ('windows', 'linux')),
  min_version  text not null,
  source_url   text not null,
  released_at  date not null,
  fetched_at   timestamptz not null,
  primary key (game_id, vendor, os)
);

-- Seed every supported vendor/OS cell from the same vendor-owned sources the
-- scheduled worker will refresh. The fixed timestamp is intentional: if the
-- worker ever stops running these rows age out instead of looking current.
insert into driver_catalog (
  vendor, os, component, gpu_series, latest_version,
  released_at, source_url, fetched_at
)
values
  (
    'nvidia', 'windows', 'gpu', null, '610.74', '2026-07-07',
    'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=942&osID=57&languageCode=1033&beta=0&isWHQL=1&dltype=-1&dch=1&upCRD=0&qnf=0&ctk=null&sort1=1&numberOfResults=1',
    '2026-07-13T00:00:00Z'
  ),
  (
    'nvidia', 'linux', 'gpu', null, '595.84', '2026-06-11',
    'https://download.nvidia.com/XFree86/Linux-x86_64/595.84/',
    '2026-07-13T00:00:00Z'
  ),
  (
    'amd', 'windows', 'gpu', null, '26.6.1', '2026-06-02',
    'https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-1.html',
    '2026-07-13T00:00:00Z'
  ),
  (
    'intel', 'windows', 'gpu', null, '32.0.101.8861', '2026-07-07',
    'https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html',
    '2026-07-13T00:00:00Z'
  ),
  (
    'amd', 'linux', 'mesa', null, '26.1.4', '2026-07-01',
    'https://docs.mesa3d.org/relnotes/26.1.4.html',
    '2026-07-13T00:00:00Z'
  ),
  (
    'intel', 'linux', 'mesa', null, '26.1.4', '2026-07-01',
    'https://docs.mesa3d.org/relnotes/26.1.4.html',
    '2026-07-13T00:00:00Z'
  );

-- Existing Phase 6 values are retained as NVIDIA/Windows requirements before
-- the legacy columns are retired. The migration file is their provenance.
insert into game_driver_requirements (
  game_id, vendor, os, min_version, source_url, released_at, fetched_at
)
select id,
       'nvidia',
       'windows',
       required_driver,
       'repo://infra/db/migrations/0012_seed_required_drivers.sql',
       required_driver_checked_at::date,
       required_driver_checked_at
  from games
 where required_driver is not null
   and required_driver_checked_at is not null
on conflict (game_id, vendor, os) do nothing;

alter table games
  drop column required_driver,
  drop column required_driver_checked_at;
