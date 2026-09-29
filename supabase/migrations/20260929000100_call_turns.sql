-- The calling agent's side of a call (caller/): which of its sessions ran the call, and
-- each spoken turn appended as it is said, so the transcript survives a dropped call.

alter table public.calls add column call_session_id text unique;

-- One turn onto a call's transcript, atomically: PostgREST cannot append to jsonb.
create function public.append_call_turn(p_session_id text, p_role text, p_text text)
returns void
language sql
set search_path = public
as $$
  update public.calls
    set transcript = transcript || jsonb_build_array(
      jsonb_build_object('role', p_role, 'text', left(p_text, 2000), 'at', now()))
    where call_session_id = p_session_id and jsonb_array_length(transcript) < 400;
$$;

revoke execute on function public.append_call_turn from public, anon, authenticated;
grant execute on function public.append_call_turn to service_role;
