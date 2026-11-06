-- Suivi du temps : sessions par fiche client (chrono ou saisie manuelle). Migration additive.
-- * L'heure de départ et d'arrêt d'un chrono est celle du SERVEUR (now()) : recharger, fermer le
--   navigateur ou ouvrir deux onglets ne change rien au temps compté.
-- * Un seul chrono en cours, garanti par la base (index unique partiel) et par un verrou : un double
--   clic ou deux onglets ne peuvent pas en lancer deux.
-- * Réservé au propriétaire dans l'application : ni le portail client (anon), ni le connecteur Claude.

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  label text check (label is null or char_length(label) <= 200),
  started_at timestamptz not null,
  ended_at timestamptz, -- null : chrono en cours
  source text not null default 'timer' check (source in ('timer', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  check (ended_at is null or ended_at - started_at <= interval '7 days'),
  check (source = 'timer' or ended_at is not null)
);
create unique index time_entries_one_running on public.time_entries ((true)) where ended_at is null;
create index time_entries_period on public.time_entries (started_at, ended_at);
create index time_entries_company on public.time_entries (company_id, started_at desc);
create trigger set_updated_at before update on public.time_entries for each row execute function public.tg_set_updated_at();

-- Une fusion de fiches emporte le temps passé vers la fiche conservée
create or replace function public.tg_time_follow_merge()
returns trigger language plpgsql as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.time_entries set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end; $$;
create trigger time_follow_merge after update of merged_into_id on public.companies
  for each row execute function public.tg_time_follow_merge();

alter table public.time_entries enable row level security;
create policy owner_all on public.time_entries for all to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.time_entries from anon;

create or replace function public.time_assert_user()
returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then raise exception 'Suivi du temps réservé à l''application' using errcode = '42501'; end if;
end; $$;

create or replace function public.time_entry_json(e public.time_entries)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'company_id', e.company_id, 'company_name', c.name, 'label', e.label,
                            'started_at', e.started_at, 'ended_at', e.ended_at, 'source', e.source, 'now', now())
    from public.companies c where c.id = e.company_id;
$$;

-- Démarrer un chrono.
-- * même client déjà en cours : rien de neuf (double clic, deuxième onglet) → {status: 'running'} ;
-- * autre client en cours, sans p_switch → {status: 'conflict', running} : rien n'est modifié ;
-- * p_switch → la session en cours est enregistrée (arrêt maintenant) PUIS la nouvelle démarre.
create or replace function public.time_start(p_company uuid, p_label text default null, p_switch boolean default false)
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
    if r.company_id = p_company then
      return jsonb_build_object('status', 'running', 'running', public.time_entry_json(r));
    end if;
    if not coalesce(p_switch, false) then
      return jsonb_build_object('status', 'conflict', 'running', public.time_entry_json(r));
    end if;
    update public.time_entries set ended_at = greatest(now(), started_at + interval '1 second') where id = r.id returning * into v_stopped;
  end if;
  insert into public.time_entries (company_id, label, started_at, source)
  values (p_company, nullif(btrim(coalesce(p_label, '')), ''), now(), 'timer') returning * into n;
  return jsonb_build_object('status', 'started', 'running', public.time_entry_json(n),
                            'stopped', case when v_stopped.id is null then null else public.time_entry_json(v_stopped) end);
end; $$;

-- Arrêter le chrono en cours (heure du serveur). Rien en cours (déjà arrêté dans un autre onglet) :
-- {status: 'none'}.
create or replace function public.time_stop()
returns jsonb language plpgsql set search_path = '' as $$
declare r public.time_entries;
begin
  perform public.time_assert_user();
  perform pg_advisory_xact_lock(hashtext('cely_time_running'));
  update public.time_entries set ended_at = greatest(now(), started_at + interval '1 second')
   where ended_at is null returning * into r;
  if r.id is null then return jsonb_build_object('status', 'none'); end if;
  return jsonb_build_object('status', 'stopped', 'stopped', public.time_entry_json(r));
end; $$;

revoke all on function public.time_start(uuid, text, boolean), public.time_stop(), public.time_assert_user(), public.time_entry_json(public.time_entries) from public, anon;
grant execute on function public.time_start(uuid, text, boolean), public.time_stop(), public.time_assert_user(), public.time_entry_json(public.time_entries) to authenticated;
