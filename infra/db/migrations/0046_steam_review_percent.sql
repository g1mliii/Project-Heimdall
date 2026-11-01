-- Phase 8.7 — review snapshots from IStoreBrowseService/GetItems.
--
-- `store.steampowered.com/appreviews/<appid>?json=1` began answering every
-- request with a 302 to the store front page on 2026-10-22, and the reviews
-- lane has written nothing since. The keyless Web API replacement
-- (`IStoreBrowseService/GetItems`, `include_reviews`) reports the review count,
-- the 0-9 band and its label, and an INTEGER percent positive — but not the
-- positive/negative split.
--
-- So new rows carry `percent_positive` and leave the split null. The split is
-- not reconstructed from the rounded percent: that would store a number Steam
-- never reported. Rows written before the change keep their exact split and a
-- null percent; a reader wanting one series computes the percent from the split
-- for those rows.
--
-- Reentrant: `drop not null` is a no-op when already nullable, the column is
-- `if not exists`, and both constraints are guarded by a lookup scoped to THIS
-- table (0044 is what an unscoped `pg_constraint` guard costs).

alter table steam_review_snapshots alter column total_positive drop not null;
alter table steam_review_snapshots alter column total_negative drop not null;

alter table steam_review_snapshots add column if not exists percent_positive smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'steam_review_snapshots_percent_check'
       and conrelid = 'steam_review_snapshots'::regclass
  ) then
    alter table steam_review_snapshots
      add constraint steam_review_snapshots_percent_check
      check (percent_positive between 0 and 100);
  end if;

  -- Every row says how its reviews split, in one form or the other — unless
  -- there are no reviews to split, where Steam's percent is a placeholder 0.
  if not exists (
    select 1 from pg_constraint
     where conname = 'steam_review_snapshots_split_check'
       and conrelid = 'steam_review_snapshots'::regclass
  ) then
    alter table steam_review_snapshots
      add constraint steam_review_snapshots_split_check
      check (
        (total_positive is not null and total_negative is not null)
        or percent_positive is not null
        or total_reviews = 0
      );
  end if;
end $$;
