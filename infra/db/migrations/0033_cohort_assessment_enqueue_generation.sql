-- Preserve a mutation that arrives while the corresponding assessment job is
-- leased. A primary-key-only enqueue would otherwise be dropped, then the
-- worker could delete the in-flight row after recomputing the old snapshot.

alter table cohort_assessment_jobs
  add column enqueue_generation bigint not null default 0
  constraint cohort_assessment_jobs_enqueue_generation_nonnegative_check
  check (enqueue_generation >= 0);

create or replace function enqueue_cohort_assessment_game(target_game_id bigint)
returns void
language plpgsql
as $$
begin
  if target_game_id is null then
    return;
  end if;

  insert into cohort_assessment_jobs (game_id)
  values (target_game_id)
  on conflict (game_id) do update
     set enqueue_generation = cohort_assessment_jobs.enqueue_generation + 1,
         -- Never make an already leased job claimable concurrently. Its worker
         -- observes the newer generation and releases it for a follow-up pass.
         not_before = case
           when cohort_assessment_jobs.locked_at is null
            and cohort_assessment_jobs.failed_at is null
             then least(cohort_assessment_jobs.not_before, now())
           else cohort_assessment_jobs.not_before
         end;
end;
$$;
