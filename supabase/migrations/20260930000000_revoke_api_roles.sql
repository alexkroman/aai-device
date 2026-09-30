-- Close every public table to the public API roles. The earlier migrations only grant to
-- service_role and assumed the CLI grants nothing else, but a fresh stack still gives anon
-- and authenticated privileges on each new table (seen in CI on the current CLI). RLS with
-- no policies already keeps their rows out of the API; this also takes away what RLS does
-- not cover, such as TRUNCATE. The agents use service_role only.
revoke all on all tables in schema public from anon, authenticated;
