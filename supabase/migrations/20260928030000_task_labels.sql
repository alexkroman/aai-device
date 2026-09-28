-- What a durable run IS, for the page's Running panel (agent/tasks.ts): a run's snapshot
-- carries its id, workflow, key and status but not its input, and its progress lines
-- live in memory only, so "call the plumber, due 5 PM" has to be written down when the
-- run starts. One row per run a tool started for a speaker.
create table public.task_labels (
  run_id text primary key,
  client_id text not null,
  workflow text not null,
  title text not null check (length(title) between 1 and 300),
  due_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.task_labels enable row level security;
create index task_labels_by_client on public.task_labels (client_id, created_at desc);

grant select, insert, update, delete on public.task_labels to service_role;
