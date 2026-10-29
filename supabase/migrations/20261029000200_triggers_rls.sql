-- Triggers (normalisation, dates, historique) et politiques RLS

-- ---------------------------------------------------------------------------
-- Dates de modification
-- ---------------------------------------------------------------------------

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['companies','people','tasks','lists','templates','campaigns','campaign_participants','pipelines']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Valeurs normalisées (les valeurs saisies restent intactes pour l'affichage)
-- ---------------------------------------------------------------------------

create or replace function public.tg_companies_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := btrim(new.name);
  new.website := nullif(btrim(coalesce(new.website, '')), '');
  new.name_norm := public.norm_company_name(new.name);
  new.domain_norm := public.norm_domain(new.website);
  new.tags := coalesce(array(select distinct btrim(t) from unnest(new.tags) t where btrim(t) <> '' order by 1), '{}');
  if new.stage_id is not null then
    if not exists (select 1 from public.stages s where s.id = new.stage_id and s.pipeline_id = new.pipeline_id) then
      raise exception 'L''étape ne fait pas partie du pipeline choisi' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger companies_normalize before insert or update on public.companies
  for each row execute function public.tg_companies_normalize();

create or replace function public.tg_people_normalize()
returns trigger
language plpgsql
as $$
begin
  new.first_name := nullif(btrim(coalesce(new.first_name, '')), '');
  new.last_name := nullif(btrim(coalesce(new.last_name, '')), '');
  new.email := nullif(btrim(coalesce(new.email, '')), '');
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.title := nullif(btrim(coalesce(new.title, '')), '');
  new.linkedin_url := nullif(btrim(coalesce(new.linkedin_url, '')), '');
  if new.email is not null and new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Email invalide : %', new.email using errcode = '22023';
  end if;
  new.email_norm := public.norm_email(new.email);
  new.linkedin_norm := public.norm_linkedin(new.linkedin_url);
  new.full_name_norm := public.norm_person_name(new.first_name, new.last_name);
  return new;
end;
$$;
create trigger people_normalize before insert or update on public.people
  for each row execute function public.tg_people_normalize();

-- ---------------------------------------------------------------------------
-- Date du dernier échange : messages, appels et rendez-vous
-- ---------------------------------------------------------------------------

create or replace function public.refresh_last_interaction(p_company uuid)
returns void
language sql
as $$
  update public.companies c
     set last_interaction_at = (
       select max(i.occurred_at) from public.interactions i
        where i.company_id = c.id and i.kind in ('message_out','message_in','call','meeting'))
   where c.id = p_company;
$$;

create or replace function public.tg_interactions_last()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT','UPDATE') then
    perform public.refresh_last_interaction(new.company_id);
  end if;
  if tg_op in ('UPDATE','DELETE') then
    if tg_op = 'DELETE' or old.company_id <> new.company_id then
      perform public.refresh_last_interaction(old.company_id);
    end if;
  end if;
  return null;
end;
$$;
create trigger interactions_last after insert or update or delete on public.interactions
  for each row execute function public.tg_interactions_last();

-- ---------------------------------------------------------------------------
-- Tâche terminée → entrée d'historique
-- ---------------------------------------------------------------------------

create or replace function public.tg_tasks_done()
returns trigger
language plpgsql
as $$
begin
  if new.done_at is not null and (tg_op = 'INSERT' or old.done_at is null) then
    insert into public.interactions (company_id, person_id, kind, occurred_at, content, content_origin, source, meta)
    values (new.company_id, new.person_id, 'task_done', new.done_at, new.title, 'system',
            case when public.current_actor() = 'claude' then 'claude' else 'user' end,
            jsonb_build_object('task_id', new.id));
  end if;
  return null;
end;
$$;
create trigger tasks_done after insert or update of done_at on public.tasks
  for each row execute function public.tg_tasks_done();

-- ---------------------------------------------------------------------------
-- Journal des écritures de Claude
-- ---------------------------------------------------------------------------

create or replace function public.tg_activity_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_company uuid;
begin
  if public.current_actor() <> 'claude' then
    return null;
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_company := case when tg_table_name = 'companies' then (v_row ->> 'id')::uuid
                    else nullif(v_row ->> 'company_id', '')::uuid end;
  insert into public.activity_log (actor, table_name, operation, row_id, company_id, summary, data)
  values ('claude', tg_table_name, tg_op, nullif(v_row ->> 'id', '')::uuid, v_company,
          coalesce(current_setting('crm.claude_summary', true), ''), v_row);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['companies','people','interactions','tasks','list_members','campaign_participants']
  loop
    execute format('create trigger activity_log after insert or update or delete on public.%I for each row execute function public.tg_activity_log()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS : tout est réservé au propriétaire. Les suppressions ne sont jamais
-- autorisées via un jeton Claude.
-- ---------------------------------------------------------------------------

alter table public.app_owner enable row level security;
create policy app_owner_self on public.app_owner for select to authenticated
  using (user_id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','pipelines','stages','companies','people','interactions','tasks','lists','list_members',
    'templates','template_steps','campaigns','campaign_steps','campaign_lists','campaign_participants',
    'duplicate_dismissals','merges','imports','import_row_keys','idempotency_keys','activity_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Le journal Claude est en lecture seule pour l'application.
drop policy owner_insert on public.activity_log;
drop policy owner_update on public.activity_log;
drop policy owner_delete on public.activity_log;

revoke all on public.app_owner from anon;
