-- The speaker's exact record of its household: a small profile the tools read
-- (agent/profile.ts) and the phone numbers waiting to be verified before texts go to
-- them. Free-form memories are not here: the mem0 platform holds those (agent/memory.ts).
--
-- Only the agent's secret key (service_role) is granted these tables, and every one
-- also has RLS on with no policies: the publishable key sees nothing either way.

-- One row per field. Exact values: a phone number or street address must come back
-- as it was given, so nothing here passes through a model.
create table public.profile (
  key text primary key check (key ~ '^[a-z][a-z_]{0,39}$'),
  value text not null check (length(value) between 1 and 500),
  updated_at timestamptz not null default now()
);
alter table public.profile enable row level security;

-- A number someone asked to be texted at, and the code texted to it. It becomes the
-- profile's `phone` only when the code is said back (agent/tools/confirm_phone.ts), so a
-- client on the LAN cannot point the agent's texts at somebody else's phone.
create table public.phone_verification (
  id bigint generated always as identity primary key,
  phone text not null,
  code_sha256 text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.phone_verification enable row level security;
create index phone_verification_created_at on public.phone_verification (created_at);

-- This CLI no longer grants new tables to the API roles, so the agent's is explicit.
grant select, insert, update, delete on public.profile, public.phone_verification
  to service_role;
