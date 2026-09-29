-- The Running panel reads what a run is from the run itself now: the SDK's workflow runs
-- carry a `label` (StartOptions.label), so the table that held one per run is gone.
drop table if exists public.task_labels;
