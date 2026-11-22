-- CMS (lot 4) : rafraîchissement du site, reprises automatiques, aperçus temporaires. Migration additive.
--  * Toute modification qui change ce que le site affiche (article visible avant ou après, page SEO) inscrit une
--    demande de rafraîchissement (cms_revalidations). Les demandes en attente sont fusionnées : un seul appel au
--    site suffit, et un appel réussi résout aussi les échecs plus anciens (il rafraîchit tout le contenu du CMS).
--  * Envoi immédiat par l'application après l'action, puis reprise par le passage planifié « contenus » avec un
--    délai croissant (1, 2, 4… minutes, une heure au plus). Les échecs restent visibles dans Aujourd'hui jusqu'à
--    leur résolution.
--  * Aperçu : jeton aléatoire (seule son empreinte est en base), valable 24 h au plus, pour un seul contenu.
--  * Passage planifié « contenus » ajouté à la liste des tâches suivies (scheduled_jobs).

create table public.cms_revalidations (
  id uuid primary key default gen_random_uuid(),
  reasons text[] not null default '{}',
  tags text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'ok', 'failed')),
  attempts integer not null default 0,
  last_error text check (char_length(last_error) <= 500),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index cms_revalidations_open_idx on public.cms_revalidations (next_attempt_at) where status in ('pending', 'running', 'failed');
alter table public.cms_revalidations enable row level security;
revoke all on public.cms_revalidations from anon;
create policy cms_revalidations_owner_read on public.cms_revalidations for select to authenticated using ((select public.is_app_owner()));

-- Ajoute une demande (ou la fusionne avec celle qui attend déjà). Appelée par les déclencheurs.
create or replace function cms_private.enqueue(p_reason text, p_tags text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.cms_revalidations where status = 'pending' order by created_at limit 1 for update skip locked;
  if v_id is null then
    insert into public.cms_revalidations (reasons, tags) values (array[left(p_reason, 200)], array(select distinct unnest(array['cms'] || p_tags)));
  else
    update public.cms_revalidations
       set reasons = (reasons || array[left(p_reason, 200)])[greatest(1, cardinality(reasons) - 18):],
           tags = array(select distinct unnest(tags || p_tags)), next_attempt_at = least(next_attempt_at, now())
     where id = v_id;
  end if;
  if random() < 0.05 then delete from public.cms_revalidations where status = 'ok' and done_at < now() - interval '30 days'; end if;
end; $$;
revoke all on function cms_private.enqueue(text, text[]) from public, anon, authenticated;

create or replace function cms_private.tg_entries_revalidate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old boolean := tg_op <> 'INSERT' and cms_private.is_visible(old.status, old.publish_at);
  v_new boolean := tg_op <> 'DELETE' and cms_private.is_visible(new.status, new.publish_at);
  v_tags text[];
begin
  if not (v_old or v_new) then return null; end if;
  if tg_op = 'UPDATE' and old.content_updated_at = new.content_updated_at and old.status = new.status
     and old.publish_at is not distinct from new.publish_at and old.slug = new.slug then
    return null;
  end if;
  v_tags := array['cms:articles', 'cms:sitemap', 'cms:redirections'];
  if tg_op <> 'INSERT' then v_tags := v_tags || ('cms:' || old.type || ':' || old.slug); end if;
  if tg_op <> 'DELETE' then v_tags := v_tags || ('cms:' || new.type || ':' || new.slug); end if;
  perform cms_private.enqueue(
    case when tg_op = 'DELETE' then 'suppression' when not v_old then 'publication' when not v_new then 'retrait' else 'modification' end
      || ' : ' || coalesce(new.slug, old.slug), v_tags);
  return null;
end; $$;
revoke all on function cms_private.tg_entries_revalidate() from public, anon, authenticated;
create trigger cms_entries_revalidate after insert or update or delete on public.cms_entries
  for each row execute function cms_private.tg_entries_revalidate();

create or replace function cms_private.tg_pages_revalidate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (old.path, old.seo_title, old.seo_description, old.og_title, old.og_image_url, old.canonical_url, old.noindex)
     is not distinct from (new.path, new.seo_title, new.seo_description, new.og_title, new.og_image_url, new.canonical_url, new.noindex) then
    return null; -- seuls le libellé ou les valeurs du site ont changé : rien à rafraîchir
  end if;
  perform cms_private.enqueue('page SEO : ' || coalesce(new.path, old.path), array['cms:pages', 'cms:page:' || coalesce(new.path, old.path)]);
  return null;
end; $$;
revoke all on function cms_private.tg_pages_revalidate() from public, anon, authenticated;
create trigger cms_pages_revalidate after insert or update or delete on public.cms_pages
  for each row execute function cms_private.tg_pages_revalidate();

-- Appelant : le propriétaire dans l'application (p_server_key null) ou le passage planifié (clé serveur).
create or replace function cms_private.assert_caller(p_server_key text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_server_key is not null then perform appt_private.assert_server(p_server_key);
  else perform cms_private.assert_writer(); end if;
end; $$;
revoke all on function cms_private.assert_caller(text) from public, anon, authenticated;

-- Prend les demandes dues (fusionnées) pour un appel au site ; null s'il n'y a rien à envoyer.
create or replace function public.cms_revalidation_claim(p_server_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_tags text[]; v_reasons text[];
begin
  perform cms_private.assert_caller(p_server_key);
  with due as (
    select id from public.cms_revalidations
     where (status in ('pending', 'failed') or (status = 'running' and locked_until < now())) and next_attempt_at <= now()
     order by created_at limit 50 for update skip locked),
  upd as (
    update public.cms_revalidations r set status = 'running', locked_until = now() + interval '2 minutes'
      from due where r.id = due.id
    returning r.id, r.tags, r.reasons)
  select (select array_agg(id) from upd),
         (select array_agg(distinct t) from upd, unnest(upd.tags) t),
         (select array_agg(x) from (select unnest(upd.reasons) x from upd limit 20) s)
    into v_ids, v_tags, v_reasons;
  if v_ids is null then return null; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'tags', to_jsonb(coalesce(v_tags, array['cms'])), 'reasons', to_jsonb(coalesce(v_reasons, '{}')));
end; $$;

-- Issue de l'appel. Réussite : ces demandes et les échecs plus anciens sont résolus. Échec : nouvel essai plus tard.
create or replace function public.cms_revalidation_report(p_ids uuid[], p_ok boolean, p_error text default null, p_server_key text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_first timestamptz;
begin
  perform cms_private.assert_caller(p_server_key);
  if p_ok then
    select max(created_at) into v_first from public.cms_revalidations where id = any (p_ids);
    update public.cms_revalidations set status = 'ok', done_at = now(), locked_until = null, last_error = null
     where id = any (p_ids) or (status = 'failed' and created_at <= coalesce(v_first, now()));
  else
    update public.cms_revalidations set status = 'failed', attempts = attempts + 1, locked_until = null,
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'Échec sans précision'), 500),
      next_attempt_at = now() + make_interval(mins => least(60, power(2, least(attempts, 6))::int))
     where id = any (p_ids);
  end if;
end; $$;

-- « Réessayer » : les échecs redeviennent dus tout de suite.
create or replace function public.cms_revalidation_retry()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform cms_private.assert_writer();
  update public.cms_revalidations set next_attempt_at = now() where status = 'failed';
  get diagnostics n = row_count;
  return n;
end; $$;

revoke all on function public.cms_revalidation_claim(text), public.cms_revalidation_report(uuid[], boolean, text, text), public.cms_revalidation_retry() from public;
grant execute on function public.cms_revalidation_claim(text), public.cms_revalidation_report(uuid[], boolean, text, text) to anon, authenticated;
grant execute on function public.cms_revalidation_retry() to authenticated;
revoke execute on function public.cms_revalidation_retry() from anon;

-- ---------------------------------------------------------------------------
-- Aperçu d'un brouillon sur le site
-- ---------------------------------------------------------------------------
create table public.cms_preview_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  entry_id uuid not null references public.cms_entries (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint cms_preview_tokens_ttl check (expires_at <= created_at + interval '24 hours')
);
create index cms_preview_tokens_entry_idx on public.cms_preview_tokens (entry_id);
alter table public.cms_preview_tokens enable row level security;
revoke all on public.cms_preview_tokens from anon;
create policy cms_preview_owner_read on public.cms_preview_tokens for select to authenticated using ((select public.is_app_owner()));
select trash_private.hide('cms_preview_tokens', array['entry_id:cms_entries']);

-- Crée un aperçu (empreinte du jeton fournie par l'application) valable p_hours heures (24 au plus).
create or replace function public.cms_preview_create(p_entry uuid, p_token_hash text, p_hours integer default 24)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_exp timestamptz;
begin
  perform cms_private.assert_writer();
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'Durée de 1 à 24 heures' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_entries where id = p_entry) or public.in_trash('cms_entries', p_entry) then
    raise exception 'Contenu introuvable' using errcode = 'P0002';
  end if;
  delete from public.cms_preview_tokens where expires_at < now();
  v_exp := now() + make_interval(hours => p_hours);
  insert into public.cms_preview_tokens (token_hash, entry_id, expires_at, created_at) values (p_token_hash, p_entry, v_exp, now());
  return v_exp;
end; $$;

-- Retire tous les aperçus d'un contenu.
create or replace function public.cms_preview_revoke(p_entry uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform cms_private.assert_writer();
  delete from public.cms_preview_tokens where entry_id = p_entry;
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function public.cms_preview_create(uuid, text, integer), public.cms_preview_revoke(uuid) from public, anon;
grant execute on function public.cms_preview_create(uuid, text, integer), public.cms_preview_revoke(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Passage planifié « contenus »
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  select pg_get_constraintdef(oid) into v from pg_constraint
   where conrelid = 'public.scheduled_jobs'::regclass and conname = 'scheduled_jobs_job_check';
  if v is not null and v not like '%''contenus''%' and v like '%ARRAY[%' then
    alter table public.scheduled_jobs drop constraint scheduled_jobs_job_check;
    execute 'alter table public.scheduled_jobs add constraint scheduled_jobs_job_check ' || replace(v, 'ARRAY[', 'ARRAY[''contenus''::text, ');
  end if;
end $$;
