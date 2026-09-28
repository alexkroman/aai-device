-- What each session started with, and the codes that link a browser to a speaker.

-- The context block a session was given at connect (agent/context.ts): the profile, the
-- memories and the compacted history, exactly as the model saw them. Written once per
-- session, so the page can show what the agent knew and when.
create table public.session_contexts (
  session_id text primary key,
  client_id text,
  instructions text not null,
  created_at timestamptz not null default now()
);
alter table public.session_contexts enable row level security;
create index session_contexts_recent on public.session_contexts (client_id, created_at desc);

-- A browser asking to join a speaker's conversation (agent/link.ts). The browser is shown
-- a code and says it to the speaker; the speaker's link_browser tool fills in its own
-- client id, and the browser, polling, adopts it. The code is stored hashed, like a
-- phone verification code, and dies after LINK_CODE_TTL or MAX_LINK_ATTEMPTS.
create table public.link_codes (
  id bigint generated always as identity primary key,
  code_sha256 text not null,
  browser_client text not null,
  speaker_client text,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.link_codes enable row level security;
create index link_codes_pending on public.link_codes (expires_at) where speaker_client is null;

grant select, insert, update, delete on public.session_contexts, public.link_codes
  to service_role;
