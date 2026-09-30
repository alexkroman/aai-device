# Local Supabase

The speaker agent's database, run on this machine by the Supabase CLI. `make agent`
starts it if it isn't up (`supabase/up.sh`); `make supabase` starts it alone and
`supabase stop` stops it. Studio is at <http://127.0.0.1:55423>.

Ports are the CLI defaults + 1000 (554xx) so it runs beside the SDK repo's own stack.

What's in it:

- `migrations/…_household_memory.sql`: the household `profile` (name, home address,
  verified phone) and pending `phone_verification` codes.
- `migrations/…_conversation_digests.sql`: each speaker's conversation compacted into
  per-session digests and one rolling older-history summary (agent/workflows/memorize.ts).

Only the agent's secret key is granted these tables.

- Nothing for durable workflows: `aai dev` creates its session-slot and workflow tables
  itself when it boots with this stack's `DATABASE_URL` (and the run-key and upload
  tables on first use). Deliberately left to the SDK, so every `make agent` runs the
  self-hosted schema path it ships.
- The private `blobs` bucket for workflow uploads (config.toml).

Free-form memories are not here: the mem0 platform holds them (agent/memory.ts).

Nothing personal is configured anywhere: the agent asks for the address and phone
number when a tool first needs them and saves them here. A new phone number is texted
a code that has to be read back first.

`supabase db reset` wipes the data and reapplies the migrations.
