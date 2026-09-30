-- Phone calls the speaker places for the household (agent/calls.ts). The owner asks, the
-- speaker drafts what the calling agent will do and reads it back, and only an approved
-- draft is dialled. The calling agent (caller/) runs the call from this row and writes
-- the transcript and outcome back to it.

create table public.calls (
  id text primary key,                    -- also the Twilio <Parameter name="call">
  client_id text not null,                -- the speaker that asked, told the outcome
  session_id text not null,               -- the session the draft was made in
  to_number text not null check (to_number ~ '^\+[1-9][0-9]{7,14}$'),
  callee text not null check (length(callee) between 1 and 120),
  goal text not null check (length(goal) between 1 and 1000),
  may_agree text not null default '',     -- what the agent may accept on the owner's behalf
  must_not text not null default '',      -- beyond the fixed guardrails
  owner_name text not null default '',
  status text not null default 'draft'
  check (status in ('draft', 'approved', 'dialing', 'in_progress', 'ended', 'failed', 'expired')),
  twilio_sid text,
  transcript jsonb not null default '[]',
  outcome text,
  error text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  ended_at timestamptz
);
alter table public.calls enable row level security;
create index calls_by_client on public.calls (client_id, created_at desc);

-- Small runtime values one process publishes for another: the calling agent's public
-- tunnel URL (make caller), which changes every time the tunnel starts.
create table public.settings (
  key text primary key check (key ~ '^[a-z][a-z_]{0,39}$'),
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;

grant select, insert, update, delete on public.calls, public.settings to service_role;
