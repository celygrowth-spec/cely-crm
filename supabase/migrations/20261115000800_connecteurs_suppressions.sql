-- Audit, lot 8 — connecteurs, accès et suppressions (K14, C14). Migration additive (contraintes resserrées).

-- ===========================================================================
-- K14 — un email envoyé apparaît dans l'historique AVEC la personne : celle choisie, sinon l'unique contact de la
-- fiche dont l'adresse est parmi les destinataires (jamais devinée entre plusieurs).
-- ===========================================================================
create or replace function public.mail_log_interaction(p_id uuid)
returns void
language plpgsql
as $$
declare
  v public.mail_messages;
  v_from text;
  v_interaction uuid;
  v_person uuid;
begin
  select * into v from public.mail_messages where id = p_id;
  if v.company_id is null or v.interaction_id is not null then return; end if;
  select email into v_from from public.mail_accounts where id = v.account_id;
  v_person := v.person_id;
  if v_person is null then
    select case when count(*) = 1 then min(p.id::text)::uuid end into v_person
      from public.people p
     where p.company_id = v.company_id and p.email_norm = any (array(select lower(btrim(x)) from unnest(v.to_addrs || v.cc_addrs) x));
  end if;
  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source, meta)
  values (v.company_id, v_person, 'message_out', 'email', coalesce(v.sent_at, now()),
          left(case when v.subject = '' then v.body_text else 'Objet : ' || v.subject || E'\n\n' || v.body_text end, 20000),
          'user', case when v.origin = 'manual' then 'user' else 'system' end,
          jsonb_build_object(
            'mail_id', v.id, 'mail_origin', v.origin,
            'subject', v.subject, 'from', v_from, 'to', v.to_addrs, 'cc', v.cc_addrs,
            'preview', left(regexp_replace(v.body_text, '\s+', ' ', 'g'), 240),
            'attachments', (select count(*) from public.mail_attachments a where a.mail_id = v.id),
            'attachment_names', coalesce((select jsonb_agg(a.name order by a.position) from public.mail_attachments a where a.mail_id = v.id), '[]'::jsonb)))
  returning id into v_interaction;
  update public.mail_messages set interaction_id = v_interaction, person_id = coalesce(person_id, v_person) where id = p_id;
end;
$$;

-- ===========================================================================
-- K14 — un contact ajouté (ou dont l'email change) rattache aussitôt les appels Fireflies « à rattacher » où il
-- figure, sans attendre le passage quotidien. Les choix manuels ne sont jamais modifiés (règle de apply_link).
-- ===========================================================================
create or replace function public.tg_people_rematch_calls()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c uuid;
begin
  if new.email_norm is null or (tg_op = 'UPDATE' and new.email_norm is not distinct from old.email_norm) then return null; end if;
  for c in select f.id from public.fireflies_calls f
            where f.link_state = 'to_link'
              and (new.email_norm = any (array(select lower(x) from unnest(f.participants) x))
                   or f.attendees::text ilike '%' || new.email_norm || '%')
            limit 50
  loop
    begin
      perform fireflies_private.apply_link(c);
    exception when others then
      raise warning 'Fireflies : rattachement reporté (%)', sqlstate;
    end;
  end loop;
  return null;
end; $$;
drop trigger if exists people_rematch_calls on public.people;
create trigger people_rematch_calls after insert or update of email_norm on public.people
  for each row execute function public.tg_people_rematch_calls();
revoke execute on function public.tg_people_rematch_calls() from public, anon;

-- ===========================================================================
-- C14 — une seule règle de suppression : une fiche qui porte des données (temps passé, diagnostic) ne se supprime
-- pas en silence ; la suppression est refusée avec une explication, comme pour le reste (ventes, finance, emails…).
-- ===========================================================================
do $$
declare r record;
begin
  for r in select con.conname, rel.relname from pg_constraint con
             join pg_class rel on rel.oid = con.conrelid
             join pg_class ref on ref.oid = con.confrelid
            where con.contype = 'f' and ref.relname = 'companies' and rel.relname in ('time_entries', 'diagnostics')
              and con.confdeltype = 'c'
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
    execute format('alter table public.%I add constraint %I foreign key (company_id) references public.companies (id) on delete restrict', r.relname, r.conname);
  end loop;
end $$;

-- Toute nouvelle fonction est fermée par défaut : exécutable seulement si sa migration l'accorde explicitement
-- (plus de fonction ouverte à tous par oubli). Les fonctions existantes gardent leurs droits actuels.
-- (le droit d'exécution de PUBLIC est un défaut global : il se retire sans « in schema »)
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

-- C14 — accès sans connexion resserrés : les fonctions de déclencheur ne sont jamais appelables, les tables récentes
-- (protégées par RLS) ne sont pas non plus lisibles par le rôle anonyme. Règle vérifiée par test : une fonction ouverte
-- sans connexion exige la clé serveur (ou sert aux politiques Storage du portail).
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prorettype = 'trigger'::regtype loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
revoke all on public.appt_rate_hits, public.company_file_texts, public.mail_sync_state, public.scheduled_jobs from anon;
