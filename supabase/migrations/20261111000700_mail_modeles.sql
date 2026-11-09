-- Mail — modèles réutilisables et personnalisation (phase 3). Migration additive.
-- * Un modèle est une base : un brouillon créé à partir d'un modèle en est une copie ; modifier l'un ne
--   touche jamais l'autre. Archiver un modèle ne touche ni les brouillons ni les emails déjà envoyés.
-- * Les variables sont stockées dans le HTML sous la forme <span data-variable="prenom">…</span>
--   et résolues au moment de l'envoi avec le contact de référence (ou une formule collective).

create table public.mail_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  category text check (category is null or char_length(category) <= 60),
  subject text not null default '' check (char_length(subject) <= 500),
  body_html text not null default '' check (char_length(body_html) <= 200000),
  body_text text not null default '' check (char_length(body_text) <= 200000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mail_templates_active_idx on public.mail_templates (archived_at, updated_at desc);
create trigger set_updated_at before update on public.mail_templates for each row execute function public.tg_set_updated_at();

alter table public.mail_templates enable row level security;
create policy owner_select on public.mail_templates for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.mail_templates for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_update on public.mail_templates for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = 'user') with check ((select public.is_app_owner()));
revoke all on public.mail_templates from anon;

-- Brouillon : modèle d'origine (trace seulement) et personnalisation choisie
--   collective = true : formule collective, aucune variable liée à une personne n'est résolue
alter table public.mail_messages
  add column template_id uuid references public.mail_templates (id) on delete set null,
  add column collective boolean not null default false;

create or replace function public.mail_save_draft(p_id uuid, p jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
as $$
declare
  v public.mail_messages;
  v_company uuid := nullif(p ->> 'company_id', '')::uuid;
  arr text[];
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Brouillon d''email');
  select * into v from public.mail_messages where id = p_id for update;
  if v.id is not null and v.status <> 'draft' then
    raise exception 'Ce message n''est plus un brouillon.' using errcode = 'P0001';
  end if;
  if v.id is not null and p_expected_version is not null and v.draft_version <> p_expected_version then
    return jsonb_build_object('conflict', true, 'current', public.mail_row(p_id));
  end if;
  insert into public.mail_messages (id, account_id, company_id, person_id, to_addrs, cc_addrs, bcc_addrs, subject, body_text, body_html,
                                    signature, in_reply_to, references_hdr, provider_thread_id, draft_version, template_id, collective)
  values (p_id,
    nullif(p ->> 'account_id', '')::uuid, v_company, nullif(p ->> 'person_id', '')::uuid,
    array(select jsonb_array_elements_text(coalesce(p -> 'to', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'cc', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'bcc', '[]'))),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'body', ''), nullif(p ->> 'html', ''), coalesce(p ->> 'signature', ''),
    p ->> 'in_reply_to', p ->> 'references', p ->> 'thread_id', 1,
    case when exists (select 1 from public.mail_templates t where t.id = nullif(p ->> 'template_id', '')::uuid) then nullif(p ->> 'template_id', '')::uuid end,
    coalesce((p ->> 'collective')::boolean, false))
  on conflict (id) do update set
    account_id = excluded.account_id, person_id = excluded.person_id, to_addrs = excluded.to_addrs,
    cc_addrs = excluded.cc_addrs, bcc_addrs = excluded.bcc_addrs, subject = excluded.subject,
    body_text = excluded.body_text, body_html = excluded.body_html, signature = excluded.signature,
    template_id = excluded.template_id, collective = excluded.collective,
    draft_version = public.mail_messages.draft_version + 1;
  if p ? 'file_ids' then
    select array(select jsonb_array_elements_text(p -> 'file_ids')) into arr;
    perform public.mail_replace_attachments(p_id, v_company, arr::uuid[]);
  end if;
  return public.mail_row(p_id) || jsonb_build_object('conflict', false);
end;
$$;
