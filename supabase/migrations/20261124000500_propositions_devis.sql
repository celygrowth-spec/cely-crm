-- Proposition : devis créé par Make pour une version, et retours de Make appliqués au devis.
--
--   * quotes : un devis, avec ce qui part à Make (client, signataire, lignes : figé à la génération, les montants
--     viennent des réponses du questionnaire), son identifiant de demande (repris par Make dans ses retours),
--     son état, puis le numéro et le lien renvoyés par Make.
--   * proposal_versions : le devis d'une version de proposition. La version est la clé : jamais deux devis pour
--     une même version. Une nouvelle version dont le devis n'a pas changé garde le même devis (rien n'est recréé).
--
-- Écritures liées en une opération : proposal_generate crée la version ET son devis, ou rien.
-- Droits : lecture pour le propriétaire dans l'application (pas pour Claude : coordonnées de facturation).
-- Aucun appel à Make sans action du propriétaire dans l'application : la réservation d'un envoi (proposal_quote_claim)
-- est refusée à Claude.

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references public.generator_dossiers (id) on delete restrict,
  company_id uuid not null references public.companies (id) on delete restrict,
  request_id uuid not null unique default gen_random_uuid(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 60000),
  payload_hash text not null,
  total_ht_cents bigint not null check (total_ht_cents >= 0),
  status text not null default 'to_send' check (status in ('to_send', 'requested', 'created', 'sent', 'signed', 'error', 'to_retry', 'cancelled')),
  number text check (number is null or char_length(number) <= 60),
  url text check (url is null or (url ~ '^https://' and char_length(url) <= 500)),
  signed_on date,
  error text check (error is null or char_length(error) <= 300),
  requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_company_idx on public.quotes (company_id, created_at desc);
create index if not exists quotes_dossier_idx on public.quotes (dossier_id, created_at desc);
drop trigger if exists set_updated_at on public.quotes;
create trigger set_updated_at before update on public.quotes for each row execute function public.tg_set_updated_at();

create table if not exists public.proposal_versions (
  version_id uuid primary key references public.generator_versions (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete restrict,
  signed_at timestamptz,
  signed_via text check (signed_via is null or signed_via in ('make', 'manual')),
  created_at timestamptz not null default now()
);
create index if not exists proposal_versions_quote_idx on public.proposal_versions (quote_id);

create or replace function public.tg_companies_merge_quotes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.quotes set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end; $$;
drop trigger if exists companies_merge_quotes on public.companies;
create trigger companies_merge_quotes after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_quotes();

do $$
declare t text;
begin
  foreach t in array array['quotes', 'proposal_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_select on public.%I', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists activity_log on public.%I', t);
    execute format('create trigger activity_log after insert or update or delete on public.%I for each row execute function public.tg_activity_log()', t);
  end loop;
end $$;

-- « Générer » une proposition : la version (generator_generate) et son devis, en une seule opération.
-- p_quote : ce qui partira à Make. Si le devis vivant de la version précédente est identique, il est repris tel
-- quel ; sinon un nouveau devis est préparé pour la nouvelle version (l'ancien garde la sienne).
create or replace function public.proposal_generate(p_id uuid, p_key text, p_feedback text, p_quote jsonb, p_total_cents bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb; v_version uuid; v_company uuid; v_kind text;
  v_hash text := md5(p_quote::text);
  v_quote public.quotes; v_new boolean := false;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Génération d''une proposition');
  select company_id, kind into v_company, v_kind from public.generator_dossiers where id = p_id for update;
  if v_company is null then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if v_kind <> 'proposal' then raise exception 'Ce dossier n''est pas une proposition' using errcode = '22023'; end if;
  if jsonb_typeof(p_quote) <> 'object' or jsonb_typeof(p_quote -> 'quote' -> 'lines') <> 'array' or jsonb_array_length(p_quote -> 'quote' -> 'lines') = 0 then
    raise exception 'Le devis n''a aucune ligne' using errcode = '22023';
  end if;
  v := public.generator_generate(p_id, p_key, p_feedback);
  v_version := (v ->> 'id')::uuid;
  select q.* into v_quote from public.proposal_versions pv join public.quotes q on q.id = pv.quote_id where pv.version_id = v_version;
  if v_quote.id is null then
    -- devis le plus récent du dossier : repris s'il est identique. Sinon un nouveau devis est préparé ; l'ancien reste
    -- attaché à sa version et reste signable (une signature d'une ancienne version fait foi).
    select * into v_quote from public.quotes where dossier_id = p_id and status <> 'cancelled' order by created_at desc limit 1;
    if v_quote.id is null or v_quote.payload_hash <> v_hash then
      insert into public.quotes (dossier_id, company_id, payload, payload_hash, total_ht_cents)
      values (p_id, v_company, p_quote, v_hash, p_total_cents) returning * into v_quote;
      v_new := true;
    end if;
    insert into public.proposal_versions (version_id, quote_id) values (v_version, v_quote.id);
  end if;
  return v || jsonb_build_object('quote_id', v_quote.id, 'quote_created', v_new, 'quote_status', v_quote.status);
end; $$;

-- Réserve l'appel à Make pour un devis : une seule fois (double clic), relançable après un échec, une erreur de
-- Make, ou dix minutes sans retour. Rend ce qu'il faut envoyer, ou null si rien n'est à envoyer.
create or replace function public.proposal_quote_claim(p_quote uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi d''un devis à Make');
  update public.quotes set status = 'requested', requested_at = now(), error = null
   where id = p_quote and (status in ('to_send', 'to_retry', 'error') or (status = 'requested' and requested_at < now() - interval '10 minutes'))
  returning * into q;
  if q.id is null then return null; end if;
  return jsonb_build_object('request_id', q.request_id, 'payload', q.payload);
end; $$;

-- Résultat de l'appel : accepté par Make (on attend son retour), ou « à relancer » avec une raison lisible.
create or replace function public.proposal_quote_result(p_quote uuid, p_ok boolean, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi d''un devis à Make');
  if p_ok then return; end if;
  update public.quotes set status = 'to_retry', error = left(coalesce(p_error, 'Make est injoignable.'), 300) where id = p_quote and status = 'requested';
end; $$;

-- Application d'un retour de Make à son devis. Les états ne reculent jamais : un « créé » reçu après « signé » ne
-- change rien. Rend 'applied', 'unchanged' ou 'ignored' (devis inconnu ou annulé).
create or replace function make_private.apply_quote_return(p_request_id uuid, p_event text, p_number text, p_url text, p_signed_on date, p_error text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_rank constant jsonb := '{"to_send":0,"to_retry":0,"error":0,"requested":1,"created":2,"sent":3,"signed":4}';
  v_target text := case p_event when 'quote.created' then 'created' when 'quote.sent' then 'sent' when 'quote.signed' then 'signed' else 'error' end;
begin
  select * into q from public.quotes where request_id = p_request_id for update;
  if q.id is null or q.status = 'cancelled' then return 'ignored'; end if;
  if v_target = 'error' then
    if q.status in ('created', 'sent', 'signed') then return 'unchanged'; end if;
    update public.quotes set status = 'error', error = coalesce(nullif(btrim(p_error), ''), 'Make a signalé une erreur.') where id = q.id;
    return 'applied';
  end if;
  update public.quotes
     set number = coalesce(nullif(btrim(p_number), ''), number), url = coalesce(p_url, url),
         signed_on = case when v_target = 'signed' then coalesce(p_signed_on, signed_on, current_date) else signed_on end,
         status = case when (v_rank ->> v_target)::int > (v_rank ->> status)::int then v_target else status end,
         error = null
   where id = q.id;
  return case when (v_rank ->> v_target)::int > (v_rank ->> q.status)::int then 'applied' else 'unchanged' end;
end; $$;
revoke execute on function make_private.apply_quote_return(uuid, text, text, text, date, text) from public, anon, authenticated;

-- Retour de Make (redéfinition complète de la fonction du connecteur) : même protection, même idempotence, et le
-- retour est maintenant appliqué au devis concerné. Renvoie : recorded, duplicate, ignored, refused, invalid, rate_limited.
create or replace function public.make_return(
  p_server_key text, p_outcome text, p_event text default null, p_request_id uuid default null,
  p_quote_number text default null, p_quote_url text default null, p_signed_on date default null, p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text := case when p_event in ('quote.created', 'quote.sent', 'quote.signed', 'quote.error') then p_event else 'inconnu' end;
  v_applied text;
begin
  perform appt_private.assert_server(p_server_key);
  -- un seul retour à la fois : le compteur ne se contourne pas par des appels simultanés
  perform pg_advisory_xact_lock(hashtext('cely_make_return'));
  if (select count(*) from public.make_calls where direction = 'in' and at > now() - interval '1 minute') >= 60 then
    return 'rate_limited';
  end if;
  if p_outcome = 'refused' then
    perform make_private.log('in', null, v_event, 'refused', 'Secret refusé.');
    return 'refused';
  end if;
  if p_outcome is distinct from 'valid' or v_event = 'inconnu' or p_request_id is null
     or char_length(coalesce(p_quote_number, '')) > 60
     or (p_quote_url is not null and (p_quote_url !~ '^https://' or char_length(p_quote_url) > 500))
     or char_length(coalesce(p_error, '')) > 300 then
    perform make_private.log('in', null, v_event, 'invalid', 'Contenu refusé.');
    return 'invalid';
  end if;
  insert into public.make_returns (request_id, event, quote_number, quote_url, signed_on, error)
  values (p_request_id, v_event, nullif(btrim(p_quote_number), ''), p_quote_url, p_signed_on, nullif(btrim(p_error), ''))
  on conflict (request_id, event) do nothing;
  if not found then
    perform make_private.log('in', null, v_event, 'duplicate', null);
    return 'duplicate';
  end if;
  v_applied := make_private.apply_quote_return(p_request_id, v_event, p_quote_number, p_quote_url, p_signed_on, p_error);
  if v_applied = 'ignored' then
    perform make_private.log('in', null, v_event, 'ignored', 'Devis inconnu ou annulé.');
    return 'ignored';
  end if;
  perform make_private.log('in', null, v_event, case when v_event = 'quote.error' then 'error' else 'ok' end,
                           case when v_event = 'quote.error' then 'Erreur signalée par Make.' end);
  return 'recorded';
end;
$$;
revoke execute on function public.make_return(text, text, text, uuid, text, text, date, text) from public;
grant execute on function public.make_return(text, text, text, uuid, text, text, date, text) to anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['proposal_generate(uuid, text, text, jsonb, bigint)', 'proposal_quote_claim(uuid)', 'proposal_quote_result(uuid, boolean, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.tg_companies_merge_quotes() from public, anon, authenticated';
end $$;
