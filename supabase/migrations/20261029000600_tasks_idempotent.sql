-- Création de tâche protégée contre la répétition d'une même requête (connecteur Claude).
create or replace function public.create_task(
  p_company uuid, p_title text, p_due date, p_person uuid default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  insert into public.tasks (company_id, person_id, title, due_date, source)
  values (p_company, p_person, btrim(p_title), p_due, case when public.current_actor() = 'claude' then 'claude' else 'user' end)
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'create_task', jsonb_build_object('status', 'created', 'id', v_id));
end;
$$;

revoke execute on function public.create_task(uuid, text, date, uuid, text) from public, anon;
grant execute on function public.create_task(uuid, text, date, uuid, text) to authenticated;
