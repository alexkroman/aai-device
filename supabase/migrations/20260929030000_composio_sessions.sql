-- The household's apps through Composio (agent/apps.ts, agent/watches.ts).

-- Each speaker's Composio sessions: the runtime context its app actions run in, kept so
-- every conversation reuses one rather than making a new session per call. `kind` is
-- which: `voice` for the conversation's tools (no sandbox: a turn can't wait on one),
-- `background` for app_task's runs (with Composio's Python workbench). The connections
-- themselves live at Composio, under the speaker's client id as its user id, so a lost
-- row only costs a new session, never a connected account.
create table public.composio_sessions (
  client_id text not null,
  kind text not null check (kind in ('voice', 'background')),
  session_id text not null,
  created_at timestamptz not null default now(),
  primary key (client_id, kind)
);

-- What a speaker asked to be told about ("tell me when Sam emails"): one Composio trigger
-- instance each, and the words to judge its events by. The webhook trusts an event only
-- when its trigger is here AND belongs to the user Composio says it does.
create table public.app_watches (
  trigger_id text primary key,
  client_id text not null,
  app text not null,
  trigger_slug text not null,
  instruction text not null,
  created_at timestamptz not null default now()
);
create index app_watches_client on public.app_watches (client_id, created_at);

-- Webhook deliveries already acted on, by Composio's event id: a redelivery after a lost
-- 200 is dropped here rather than announced twice.
create table public.app_events (
  event_id text primary key,
  trigger_id text not null,
  received_at timestamptz not null default now()
);

alter table public.composio_sessions enable row level security;
alter table public.app_watches enable row level security;
alter table public.app_events enable row level security;

grant select, insert, update, delete
on public.composio_sessions, public.app_watches, public.app_events
to service_role;
