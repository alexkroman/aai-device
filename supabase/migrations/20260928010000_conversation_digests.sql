-- What each speaker's one long conversation is compacted into, so every connect can load
-- it whole (agent/context.ts) without the model reading months of turns. The raw
-- transcript stays in the SDK's session log; these are the model's view of it.
--
-- memorize (agent/workflows/memorize.ts) writes one digest per session when it ends, and
-- folds the oldest into a single rolling summary once there are too many to load.

-- One session's digest: what was asked and done, and what was left open, in a few
-- bullets. `through_event` is the watermark: the session event index the digest covers,
-- so a session resumed after it was digested is digested again from there.
create table public.conversation_digests (
  client_id text not null,
  session_id text not null,
  started_at timestamptz not null,
  through_event bigint not null,
  digest text not null check (length(digest) <= 2000),
  created_at timestamptz not null default now(),
  primary key (client_id, session_id)
);
alter table public.conversation_digests enable row level security;
create index conversation_digests_recent on public.conversation_digests (client_id, started_at desc);

-- Everything older than the digests loaded one by one, folded into one rolling summary
-- per client. `through` is the newest session start it has absorbed.
create table public.older_history (
  client_id text primary key,
  summary text not null check (length(summary) <= 6000),
  through timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.older_history enable row level security;

-- Write the rolling summary and drop the digests it absorbed in ONE transaction, so a
-- crash between the two cannot lose them or count them twice.
create function public.fold_older_history(p_client_id text, p_summary text, p_through timestamptz)
returns void
language sql
set search_path = public
as $$
  insert into public.older_history (client_id, summary, through)
    values (p_client_id, p_summary, p_through)
    on conflict (client_id) do update
      set summary = excluded.summary, through = excluded.through, updated_at = now();
  delete from public.conversation_digests
    where client_id = p_client_id and started_at <= p_through;
$$;

revoke execute on function public.fold_older_history from public, anon, authenticated;
grant select, insert, update, delete on public.conversation_digests, public.older_history
  to service_role;
grant execute on function public.fold_older_history to service_role;
