-- Paramètres › Connecteurs › Carte.
-- 1. mcp_clients : dernière activité de chaque client MCP (un Claude = un client OAuth = un client_id). Le client
--    s'identifie par son jeton : la fonction lit client_id dans le JWT, jamais dans un paramètre. Aucun jeton ni
--    secret n'y est stocké ; client_id est l'identifiant public du client OAuth.
-- 2. connector_map_tools : outils déclarés à la main, invisibles pour le CRM (ex. Tiime derrière Make).
-- Tout est réservé au propriétaire dans l'application (RLS) ; Claude ne lit ni n'écrit ces tables directement.
-- Indépendante des autres migrations en cours : seules les fonctions de base (is_app_owner, current_actor) sont
-- utilisées, et tout est écrit pour pouvoir être rejoué.

create table if not exists public.mcp_clients (
  client_id text primary key check (char_length(client_id) between 1 and 200),
  client_name text check (client_name is null or char_length(client_name) <= 80),
  client_version text check (client_version is null or char_length(client_version) <= 40),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  calls bigint not null default 1
);

alter table public.mcp_clients enable row level security;
drop policy if exists owner_select on public.mcp_clients;
create policy owner_select on public.mcp_clients for select to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.mcp_clients from anon;
revoke insert, update, delete, truncate on public.mcp_clients from authenticated;

-- Appelée par le serveur MCP avec le jeton du client. Écriture limitée : une mise à jour au plus toutes les 30 s
-- par client (le compteur reste approximatif), nom et version facultatifs (message « initialize »).
create or replace function public.touch_mcp_client(p_name text default null, p_version text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text := nullif(auth.jwt() ->> 'client_id', '');
  v_name text := nullif(left(regexp_replace(coalesce(p_name, ''), '[^[:alnum:] ._()/-]', '', 'g'), 80), '');
  v_version text := nullif(left(regexp_replace(coalesce(p_version, ''), '[^[:alnum:] ._+-]', '', 'g'), 40), '');
begin
  if v_client is null or not public.is_app_owner() then
    return;
  end if;
  insert into public.mcp_clients as m (client_id, client_name, client_version)
  values (left(v_client, 200), v_name, v_version)
  on conflict (client_id) do update
    set last_seen_at = now(),
        calls = m.calls + 1,
        client_name = coalesce(excluded.client_name, m.client_name),
        client_version = coalesce(excluded.client_version, m.client_version)
    where m.last_seen_at < now() - interval '30 seconds' or excluded.client_name is not null;
end;
$$;
revoke all on function public.touch_mcp_client(text, text) from public, anon;
grant execute on function public.touch_mcp_client(text, text) to authenticated;

create table if not exists public.connector_map_tools (
  id uuid primary key default gen_random_uuid(),
  -- parent : le CRM (core), un connecteur, un client MCP, ou un autre outil déclaré (parent_tool)
  parent_key text check (parent_key ~ '^(core|connector:[a-z_]{1,40}|mcp:unknown|mcp:[A-Za-z0-9._:-]{1,200})$'),
  parent_tool uuid references public.connector_map_tools (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60 and name = btrim(name)),
  created_at timestamptz not null default now(),
  constraint connector_map_tools_one_parent check ((parent_key is null) <> (parent_tool is null))
);
-- un double clic ou deux onglets ne créent pas de doublon sous le même parent
create unique index if not exists connector_map_tools_unique_idx
  on public.connector_map_tools (coalesce(parent_tool::text, parent_key), lower(name));

alter table public.connector_map_tools enable row level security;
drop policy if exists owner_select on public.connector_map_tools;
drop policy if exists owner_insert on public.connector_map_tools;
drop policy if exists owner_delete on public.connector_map_tools;
create policy owner_select on public.connector_map_tools for select to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_insert on public.connector_map_tools for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_delete on public.connector_map_tools for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.connector_map_tools from anon;
revoke update, truncate on public.connector_map_tools from authenticated;
