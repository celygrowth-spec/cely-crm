-- Modèles de prospection : enregistrement atomique des étapes et duplication.

create or replace function public.save_template(p_id uuid, p_name text, p_steps jsonb)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := p_id;
  s jsonb;
  i int := 0;
begin
  perform public.assert_owner();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Le nom du modèle est obligatoire' using errcode = '22023'; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Ajoutez au moins une étape' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.templates (name) values (btrim(p_name)) returning id into v_id;
  else
    update public.templates set name = btrim(p_name) where id = v_id;
    if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
    delete from public.template_steps where template_id = v_id;
  end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if coalesce(btrim(s ->> 'name'), '') = '' then
      raise exception 'Étape % : le nom est obligatoire', i using errcode = '22023';
    end if;
    insert into public.template_steps (template_id, position, name, channel, delay_days, message)
    values (v_id, i, btrim(s ->> 'name'), coalesce(s ->> 'channel', 'other'),
            coalesce(nullif(s ->> 'delay_days', '')::int, 0), nullif(btrim(coalesce(s ->> 'message', '')), ''));
  end loop;
  return v_id;
end;
$$;

create or replace function public.duplicate_template(p_id uuid)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.templates (name)
  select name || ' (copie)' from public.templates where id = p_id
  returning id into v_id;
  if v_id is null then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  insert into public.template_steps (template_id, position, name, channel, delay_days, message)
  select v_id, position, name, channel, delay_days, message from public.template_steps where template_id = p_id;
  return v_id;
end;
$$;

revoke execute on function public.save_template(uuid, text, jsonb), public.duplicate_template(uuid) from public, anon;
grant execute on function public.save_template(uuid, text, jsonb), public.duplicate_template(uuid) to authenticated;
