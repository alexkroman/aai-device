-- pgTAP over the migrations, run by `supabase test db` (make test-supabase) against a
-- database they were just applied to from zero. It pins what the agents rely on and a
-- mistake in a migration would silently change: every table is closed to the public API
-- roles (RLS on, no grants to anon or authenticated) and open to the agents' service_role,
-- and the two RPCs do what their callers assume.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

-- Access -------------------------------------------------------------------------------

select is(
  (
    select array_agg(c.relname::text order by c.relname)
    from pg_class as c
    where
      c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      and not c.relrowsecurity
  ),
  null,
  'every public table has row level security on'
);

select is(
  (
    select array_agg(distinct grantee || ' on ' || table_name order by grantee || ' on ' || table_name)
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
  ),
  null,
  'anon and authenticated have no grant on any public table'
);

select is(
  (
    select array_agg(c.relname::text order by c.relname)
    from pg_class as c
    where
      c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      and not (
        has_table_privilege('service_role', c.oid, 'select')
        and has_table_privilege('service_role', c.oid, 'insert')
        and has_table_privilege('service_role', c.oid, 'update')
        and has_table_privilege('service_role', c.oid, 'delete')
      )
  ),
  null,
  'service_role can read and write every public table'
);

select ok(
  not has_function_privilege('anon', 'public.fold_older_history(text, text, timestamptz)', 'execute')
  and not has_function_privilege(
    'authenticated', 'public.fold_older_history(text, text, timestamptz)', 'execute'
  )
  and has_function_privilege('service_role', 'public.fold_older_history(text, text, timestamptz)', 'execute'),
  'only service_role can execute fold_older_history'
);

select ok(
  not has_function_privilege('anon', 'public.append_call_turn(text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.append_call_turn(text, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.append_call_turn(text, text, text)', 'execute'),
  'only service_role can execute append_call_turn'
);

select hasnt_table('public', 'task_labels', 'task_labels was dropped');

-- fold_older_history -------------------------------------------------------------------

insert into public.conversation_digests (client_id, session_id, started_at, through_event, digest)
values
('speaker', 's1', '2026-09-01T10:00Z', 1, 'first'),
('speaker', 's2', '2026-09-02T10:00Z', 2, 'second'),
('speaker', 's3', '2026-09-03T10:00Z', 3, 'third'),
('other', 's4', '2026-09-01T10:00Z', 4, 'someone else');

select public.fold_older_history('speaker', 'the first two', '2026-09-02T10:00Z');

select results_eq(
  $$select session_id from public.conversation_digests order by session_id$$,
  array['s3', 's4'],
  'fold_older_history deletes the folded digests, and only that client''s'
);

select results_eq(
  $$select summary, through from public.older_history where client_id = 'speaker'$$,
  $$values ('the first two', '2026-09-02T10:00Z'::timestamptz)$$,
  'fold_older_history saves the summary'
);

select public.fold_older_history('speaker', 'all three', '2026-09-03T10:00Z');

select results_eq(
  $$select summary from public.older_history where client_id = 'speaker'$$,
  array['all three'],
  'a second fold replaces the summary rather than adding one'
);

-- append_call_turn ---------------------------------------------------------------------

insert into public.calls (id, client_id, session_id, to_number, callee, goal, call_session_id)
values ('call_1', 'speaker', 'sess', '+15035550147', 'Luigi''s', 'Book a table', 'twilio_1');

select public.append_call_turn('twilio_1', 'assistant', 'Hi, I''m calling for Sam.');
select public.append_call_turn('twilio_1', 'user', repeat('x', 3000));
select public.append_call_turn('no_such_session', 'user', 'lost');

select is(
  (
    select jsonb_array_length(transcript) from public.calls
    where id = 'call_1'
  ),
  2,
  'append_call_turn appends to the call with that session, and nothing else'
);

select is(
  (
    select transcript -> 0 ->> 'text' from public.calls
    where id = 'call_1'
  ),
  'Hi, I''m calling for Sam.',
  'append_call_turn keeps the text'
);

select is(
  (
    select length(transcript -> 1 ->> 'text') from public.calls
    where id = 'call_1'
  ),
  2000,
  'append_call_turn truncates a turn to 2000 characters'
);

update public.calls
set
  transcript
  = (select jsonb_agg(jsonb_build_object('role', 'user', 'text', i::text)) from generate_series(1, 400) as i)
where id = 'call_1';
select public.append_call_turn('twilio_1', 'user', 'one too many');

select is(
  (
    select jsonb_array_length(transcript) from public.calls
    where id = 'call_1'
  ),
  400,
  'append_call_turn stops at 400 turns'
);

-- Constraints --------------------------------------------------------------------------

select throws_ok(
  $$insert into public.calls (id, client_id, session_id, to_number, callee, goal)
    values ('call_2', 'speaker', 'sess', '5035550147', 'Luigi''s', 'Book a table')$$,
  '23514',
  null,
  'calls.to_number must be E.164'
);

select throws_ok(
  $$update public.calls set status = 'on_hold' where id = 'call_1'$$,
  '23514',
  null,
  'calls.status is one of the known states'
);

select throws_ok(
  $$insert into public.profile (key, value) values ('Home Address', 'x')$$,
  '23514',
  null,
  'profile keys are snake_case'
);

select finish();
rollback;
