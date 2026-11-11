-- Audit, lot 7 — préparation réelle de l'onboarding (K10), temps et appels par projet (K09), chrono oublié (Q09).
-- Migration additive : une table de textes extraits, deux colonnes project_id, deux colonnes de correction.

-- ===========================================================================
-- K10 — contenu lisible des documents (proposition, contrat, brief) : extrait par le serveur, conservé avec son
-- statut (lu, vide, format non lu, échec) pour que la préparation et Claude lisent le document, pas seulement son nom.
-- ===========================================================================
create table if not exists public.company_file_texts (
  file_id uuid primary key references public.company_files (id) on delete cascade,
  status text not null check (status in ('ok', 'empty', 'unsupported', 'failed')),
  text text check (text is null or char_length(text) <= 200000),
  chars int not null default 0,
  error text check (error is null or char_length(error) <= 500),
  extracted_at timestamptz not null default now()
);
alter table public.company_file_texts enable row level security;
drop policy if exists owner_all on public.company_file_texts;
create policy owner_all on public.company_file_texts for all to authenticated
  using ((select public.is_app_owner())) with check ((select public.is_app_owner()));

-- Les sources de la préparation incluent le texte des documents (la proposition retenue en premier : référence des
-- engagements), avec ce qui n'a pas pu être lu. Fireflies et le diagnostic enrichissent le contexte.
create or replace function public.onboarding_documents(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.project_onboarding; v_company uuid;
begin
  perform public.assert_owner();
  select * into o from public.project_onboarding where project_id = p_project;
  if not found then raise exception 'Préparation introuvable' using errcode = 'P0002'; end if;
  select company_id into v_company from public.projects where id = p_project;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'file_id', f.id, 'nom', f.display_name, 'categorie', f.category, 'reference_des_engagements', f.id = o.proposal_file_id,
             'lecture', coalesce(t.status, 'a_lire'), 'erreur', t.error, 'caracteres', coalesce(t.chars, 0),
             'texte', left(t.text, 60000))
           order by (f.id = o.proposal_file_id) desc, f.created_at desc)
      from public.company_files f left join public.company_file_texts t on t.file_id = f.id
     where f.company_id = v_company and f.status = 'ready' and f.category in ('Proposition', 'Contrat', 'Brief')), '[]');
end; $$;

-- Fichiers de la fiche à lire (texte absent ou plus ancien que le fichier).
create or replace function public.onboarding_files_to_read(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  perform public.assert_owner();
  select company_id into v_company from public.projects where id = p_project;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'storage_path', f.storage_path, 'mime_type', f.mime_type, 'name', f.display_name))
    from public.company_files f left join public.company_file_texts t on t.file_id = f.id
   where f.company_id = v_company and f.status = 'ready' and f.category in ('Proposition', 'Contrat', 'Brief')
     and (t.file_id is null or (t.status = 'failed' and t.extracted_at < now() - interval '10 minutes'))), '[]');
end; $$;

-- ===========================================================================
-- K09 — projet facultatif sur le temps passé et sur un appel Fireflies (même fiche obligatoire)
-- ===========================================================================
alter table public.time_entries add column if not exists project_id uuid references public.projects (id) on delete set null;
alter table public.time_entries add column if not exists corrected_at timestamptz;
alter table public.time_entries add column if not exists correction_note text check (correction_note is null or char_length(correction_note) <= 300);
create index if not exists time_entries_project on public.time_entries (project_id, started_at desc) where project_id is not null;
alter table public.fireflies_calls add column if not exists project_id uuid references public.projects (id) on delete set null;

create or replace function public.tg_project_same_company()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null and not exists (select 1 from public.projects p where p.id = new.project_id and p.company_id = new.company_id) then
    raise exception 'Ce projet appartient à une autre fiche.' using errcode = '22023';
  end if;
  return new;
end; $$;
drop trigger if exists time_project_same_company on public.time_entries;
create trigger time_project_same_company before insert or update of project_id, company_id on public.time_entries
  for each row execute function public.tg_project_same_company();
drop trigger if exists call_project_same_company on public.fireflies_calls;
create trigger call_project_same_company before insert or update of project_id, company_id on public.fireflies_calls
  for each row execute function public.tg_project_same_company();
-- un appel détaché de sa fiche perd aussi son projet (sinon le contrôle ci-dessus le refuserait)
create or replace function public.tg_call_clear_project()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.company_id is distinct from old.company_id then new.project_id := null; end if;
  return new;
end; $$;
drop trigger if exists call_clear_project on public.fireflies_calls;
create trigger call_clear_project before update of company_id on public.fireflies_calls
  for each row execute function public.tg_call_clear_project();

create or replace function public.fireflies_set_project(p_call uuid, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  perform public.assert_owner();
  select company_id into v_company from public.fireflies_calls where id = p_call;
  if v_company is null then raise exception 'Rattachez d''abord l''appel à une fiche.' using errcode = '22023'; end if;
  update public.fireflies_calls set project_id = p_project where id = p_call;
  return jsonb_build_object('id', p_call, 'project_id', p_project);
end; $$;

create or replace function public.time_entry_json(e public.time_entries)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'company_id', e.company_id, 'company_name', c.name, 'label', e.label,
                            'project_id', e.project_id, 'project_name', (select name from public.projects where id = e.project_id),
                            'started_at', e.started_at, 'ended_at', e.ended_at, 'source', e.source, 'now', now(),
                            'corrected_at', e.corrected_at)
    from public.companies c where c.id = e.company_id;
$$;

-- ===========================================================================
-- Q09 — un chrono oublié s'arrête toujours : au-delà de 12 h, une heure de fin raisonnable est PROPOSÉE (début + 8 h,
-- jamais après maintenant) et confirmée ; la correction est tracée. Le plafond de 7 jours par session reste.
-- ===========================================================================
drop function if exists public.time_stop();
create or replace function public.time_stop(p_ended_at timestamptz default null)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.time_entries; v_end timestamptz;
begin
  perform public.time_assert_user();
  perform pg_advisory_xact_lock(hashtext('cely_time_running'));
  select * into r from public.time_entries where ended_at is null for update;
  if r.id is null then return jsonb_build_object('status', 'none'); end if;
  if p_ended_at is null then
    if now() - r.started_at > interval '12 hours' then
      return jsonb_build_object('status', 'confirm_end', 'running', public.time_entry_json(r),
                                'suggested', least(now(), r.started_at + interval '8 hours'));
    end if;
    update public.time_entries set ended_at = greatest(now(), started_at + interval '1 second') where id = r.id returning * into r;
  else
    v_end := p_ended_at;
    if v_end <= r.started_at or v_end > now() + interval '1 minute' or v_end - r.started_at > interval '7 days' then
      raise exception 'Heure de fin invalide : entre le début du chrono et maintenant, 7 jours au plus.' using errcode = '22023';
    end if;
    update public.time_entries set ended_at = least(v_end, now()), corrected_at = now(),
           correction_note = 'Chrono oublié : fin confirmée à ' || to_char(least(v_end, now()) at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI')
     where id = r.id returning * into r;
  end if;
  return jsonb_build_object('status', 'stopped', 'stopped', public.time_entry_json(r));
end; $$;

drop function if exists public.time_start(uuid, text, boolean);
create or replace function public.time_start(p_company uuid, p_label text default null, p_switch boolean default false, p_project uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.time_entries; v_stopped public.time_entries; n public.time_entries;
begin
  perform public.time_assert_user();
  perform pg_advisory_xact_lock(hashtext('cely_time_running'));
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  select * into r from public.time_entries where ended_at is null for update;
  if r.id is not null then
    if r.company_id = p_company and r.project_id is not distinct from p_project then
      return jsonb_build_object('status', 'running', 'running', public.time_entry_json(r));
    end if;
    if not coalesce(p_switch, false) then
      return jsonb_build_object('status', 'conflict', 'running', public.time_entry_json(r));
    end if;
    if now() - r.started_at > interval '12 hours' then
      -- chrono oublié : sa fin se confirme d'abord (Q09)
      return jsonb_build_object('status', 'confirm_end', 'running', public.time_entry_json(r), 'suggested', least(now(), r.started_at + interval '8 hours'));
    end if;
    update public.time_entries set ended_at = greatest(now(), started_at + interval '1 second') where id = r.id returning * into v_stopped;
  end if;
  insert into public.time_entries (company_id, project_id, label, started_at, source)
  values (p_company, p_project, nullif(btrim(coalesce(p_label, '')), ''), now(), 'timer') returning * into n;
  return jsonb_build_object('status', 'started', 'running', public.time_entry_json(n),
                            'stopped', case when v_stopped.id is null then null else public.time_entry_json(v_stopped) end);
end; $$;

do $$
declare f text;
begin
  foreach f in array array['public.time_start(uuid, text, boolean, uuid)', 'public.time_stop(timestamptz)', 'public.time_entry_json(public.time_entries)',
                           'public.fireflies_set_project(uuid, uuid)', 'public.onboarding_documents(uuid)', 'public.onboarding_files_to_read(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.tg_project_same_company(), public.tg_call_clear_project() from public, anon;

-- La liste des appels expose le projet (colonne ajoutée en fin de vue)
do $$
declare v text; i int;
begin
  v := pg_get_viewdef('public.fireflies_call_list'::regclass, false);
  if position('project_id' in v) > 0 then return; end if;
  i := position(E'\n   FROM ' in v);
  if i = 0 then raise exception 'fireflies_call_list : forme inattendue'; end if;
  execute 'create or replace view public.fireflies_call_list with (security_invoker = true) as '
          || substr(v, 1, i - 1) || ', c.project_id, (select p.name from public.projects p where p.id = c.project_id) as project_name' || substr(v, i);
end $$;
