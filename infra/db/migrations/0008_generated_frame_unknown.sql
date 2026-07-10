-- Capture formats can identify generated frames without identifying the
-- vendor technology. Preserve that truth instead of misclassifying them as
-- native frames (`none`).

alter table runs
  drop constraint runs_generated_frame_tech_check;

alter table runs
  add constraint runs_generated_frame_tech_check
  check (generated_frame_tech in ('none', 'unknown', 'dlss3', 'fsr3', 'xess'))
  not valid;

update runs r
   set generated_frame_tech = 'unknown'
  from run_summaries s
 where s.run_id = r.id
   and s.generated_frame_pct > 0
   and r.generated_frame_tech = 'none';

-- Keep the full-table validation scan out of the stronger ADD CONSTRAINT lock.
alter table runs validate constraint runs_generated_frame_tech_check;
