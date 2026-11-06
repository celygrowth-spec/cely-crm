-- Espace Connecteurs : mémorise le résultat de la dernière vérification À LA DEMANDE de chaque
-- connecteur (aucun secret : un statut, une date et un message lisible). Migration additive.
-- L'état de chaque connecteur reste lu dans ses propres tables (mail_accounts, appt_google_connection,
-- fireflies_connection) : cette table ne fait que dater les vérifications manuelles.

create table public.connector_checks (
  key text primary key check (key in ('gmail', 'google_calendar', 'fireflies', 'claude_mcp')),
  checked_at timestamptz not null default now(),
  ok boolean not null,
  message text check (message is null or char_length(message) <= 300)
);

alter table public.connector_checks enable row level security;
create policy owner_select on public.connector_checks for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.connector_checks for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_update on public.connector_checks for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user') with check ((select public.is_app_owner()));
revoke all on public.connector_checks from anon;
