-- Connecteur Make : scénarios enregistrés par le propriétaire, journal court des appels, retours de Make.
--
--   * make_scenarios : un nom et l'adresse du webhook, CHIFFRÉE par le serveur avant l'écriture (la clé reste dans
--     l'environnement serveur). Une lecture de la base ne donne aucune adresse utilisable. Un futur scénario
--     s'ajoute depuis Paramètres › Connecteurs, sans code.
--   * make_calls : date, scénario, événement, statut, message d'erreur écrit par le CRM. Ni contenu envoyé, ni
--     donnée personnelle, ni secret. Borné aux 200 dernières lignes.
--   * make_returns : un retour de Make par couple (demande, événement) : le même retour reçu deux fois ne
--     s'enregistre qu'une fois. La route publique passe par make_return, protégée par la clé serveur
--     (appt_private.assert_server) ; le secret partagé avec Make est vérifié par la route, avant l'appel.
--
-- Migration additive : aucune table existante n'est modifiée. Réservé au propriétaire dans l'application :
-- ni anonyme, ni autre compte, ni Claude (connecteur MCP).

create table if not exists public.make_scenarios (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  webhook_enc text not null check (webhook_enc like 'v1.%' and char_length(webhook_enc) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists set_updated_at on public.make_scenarios;
create trigger set_updated_at before update on public.make_scenarios
  for each row execute function public.tg_set_updated_at();

alter table public.make_scenarios enable row level security;
drop policy if exists owner_select on public.make_scenarios;
create policy owner_select on public.make_scenarios for select to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
drop policy if exists owner_insert on public.make_scenarios;
create policy owner_insert on public.make_scenarios for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
drop policy if exists owner_update on public.make_scenarios;
create policy owner_update on public.make_scenarios for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
drop policy if exists owner_delete on public.make_scenarios;
create policy owner_delete on public.make_scenarios for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.make_scenarios from anon;

create table if not exists public.make_calls (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  direction text not null check (direction in ('out', 'in')),
  scenario text check (scenario is null or char_length(scenario) <= 80),
  event text not null check (char_length(event) <= 40),
  status text not null check (status in ('ok', 'error', 'duplicate', 'ignored', 'refused', 'invalid')),
  error text check (error is null or char_length(error) <= 300)
);
create index if not exists make_calls_at_idx on public.make_calls (at desc);

alter table public.make_calls enable row level security;
drop policy if exists owner_select on public.make_calls;
create policy owner_select on public.make_calls for select to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.make_calls from anon;
revoke insert, update, delete on public.make_calls from authenticated;

create table if not exists public.make_returns (
  request_id uuid not null,
  event text not null check (event in ('quote.created', 'quote.sent', 'quote.signed', 'quote.error')),
  quote_number text check (quote_number is null or char_length(quote_number) <= 60),
  quote_url text check (quote_url is null or (quote_url ~ '^https://' and char_length(quote_url) <= 500)),
  signed_on date,
  error text check (error is null or char_length(error) <= 300),
  received_at timestamptz not null default now(),
  primary key (request_id, event)
);

alter table public.make_returns enable row level security;
drop policy if exists owner_select on public.make_returns;
create policy owner_select on public.make_returns for select to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.make_returns from anon;
revoke insert, update, delete on public.make_returns from authenticated;

-- Écriture du journal : interne (appelée par les fonctions ci-dessous seulement).
create schema if not exists make_private;
revoke all on schema make_private from public, anon, authenticated;

create or replace function make_private.log(p_direction text, p_scenario text, p_event text, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.make_calls (direction, scenario, event, status, error)
  values (p_direction, left(p_scenario, 80), left(coalesce(p_event, 'inconnu'), 40), p_status, left(p_error, 300));
  delete from public.make_calls where id <= (select max(id) - 200 from public.make_calls);
end;
$$;
revoke execute on function make_private.log(text, text, text, text, text) from public, anon, authenticated;

-- Appel sortant : le serveur de l'application note son résultat (jamais le contenu envoyé).
create or replace function public.make_log_call(p_scenario text, p_event text, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'Les appels à Make se font dans l''application.' using errcode = '42501';
  end if;
  perform make_private.log('out', p_scenario, p_event, case when p_ok then 'ok' else 'error' end, case when p_ok then null else p_error end);
end;
$$;
revoke execute on function public.make_log_call(text, text, boolean, text) from public, anon;
grant execute on function public.make_log_call(text, text, boolean, text) to authenticated;

-- Retour de Make. p_outcome : 'valid' (secret accepté, contenu validé par la route), 'refused' (secret refusé)
-- ou 'invalid' (contenu refusé). Renvoie : recorded, duplicate, refused, invalid ou rate_limited.
-- Au plus 60 retours par minute, tous cas confondus : au-delà, rien n'est écrit.
create or replace function public.make_return(
  p_server_key text, p_outcome text, p_event text default null, p_request_id uuid default null,
  p_quote_number text default null, p_quote_url text default null, p_signed_on date default null, p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_event text := case when p_event in ('quote.created', 'quote.sent', 'quote.signed', 'quote.error') then p_event else 'inconnu' end;
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
  perform make_private.log('in', null, v_event, case when v_event = 'quote.error' then 'error' else 'ok' end,
                           case when v_event = 'quote.error' then 'Erreur signalée par Make.' end);
  return 'recorded';
end;
$$;
revoke execute on function public.make_return(text, text, text, uuid, text, text, date, text) from public;
grant execute on function public.make_return(text, text, text, uuid, text, text, date, text) to anon, authenticated;
