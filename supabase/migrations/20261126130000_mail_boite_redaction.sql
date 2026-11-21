-- Mail, lot M04 — rédaction : un brouillon Gmail ne part qu'une fois, même sur un double clic ou depuis deux onglets.
-- Migration additive : une table de verrous d'envoi (aucun contenu de message) et deux fonctions à clé serveur.

create table if not exists public.mailbox_sends (
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  draft_id text not null check (char_length(draft_id) <= 200),
  claimed_at timestamptz not null default now(),
  primary key (account_id, draft_id)
);
alter table public.mailbox_sends enable row level security;
revoke all on public.mailbox_sends from anon, authenticated;

-- Vrai : cet appel a le droit d'envoyer ce brouillon. Faux : un envoi de ce brouillon est déjà en cours ou fait.
-- Un verrou abandonné (serveur interrompu) expire après 10 minutes ; les verrous de plus de 7 jours sont retirés.
create or replace function public.mailbox_send_claim(p_server_key text, p_account uuid, p_draft text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  delete from public.mailbox_sends where claimed_at < now() - interval '7 days'
     or (account_id = p_account and draft_id = p_draft and claimed_at < now() - interval '10 minutes');
  insert into public.mailbox_sends (account_id, draft_id) values (p_account, p_draft) on conflict do nothing;
  return found;
end;
$$;

-- Envoi certainement pas parti : le brouillon peut être renvoyé.
create or replace function public.mailbox_send_release(p_server_key text, p_account uuid, p_draft text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  delete from public.mailbox_sends where account_id = p_account and draft_id = p_draft;
end;
$$;

revoke execute on function public.mailbox_send_claim(text, uuid, text) from public;
revoke execute on function public.mailbox_send_release(text, uuid, text) from public;
grant execute on function public.mailbox_send_claim(text, uuid, text) to anon, authenticated;
grant execute on function public.mailbox_send_release(text, uuid, text) to anon, authenticated;

-- Déconnexion du compte : les verrous d'envoi partent avec l'index.
create or replace function public.tg_mailbox_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.mailbox_messages where account_id = new.id;
  delete from public.mailbox_threads where account_id = new.id;
  delete from public.mailbox_labels where account_id = new.id;
  delete from public.mailbox_sync where account_id = new.id;
  delete from public.mailbox_sends where account_id = new.id;
  return new;
end;
$$;
