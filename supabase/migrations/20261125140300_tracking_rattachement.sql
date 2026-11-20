-- Tracking site · lots 3 et 4 : rattachement des rendez-vous à leur source, parcours dans la fiche, source déclarée,
-- signal « un prospect revient sur le site ».
--
-- - Un rendez-vous pris par la réservation publique reçoit la source et les UTM de la visite en cours, même sans
--   consentement (aucun identifiant : seule la visite est citée). Avec consentement, les visites précédentes du
--   visiteur donnent la première source.
-- - Une seule attribution par rendez-vous (double envoi sans effet). Annulation ou échec : le rendez-vous n'est plus
--   compté, sans rien supprimer ; les statistiques lisent le statut courant du rendez-vous.
-- - La source de la fiche est remplie avec la première source quand elle est vide, jamais remplacée.
-- Rejouable.

create table if not exists public.site_attributions (
  id uuid primary key default gen_random_uuid(),
  -- nul uniquement pour le jeu de données fictives
  booking_id uuid references public.appt_bookings (id) on delete cascade,
  visit_id uuid references public.site_visits (id) on delete set null,
  visitor_id uuid references public.site_visitors (id) on delete set null,
  converted_at timestamptz not null default now(),
  first_visit_id uuid references public.site_visits (id) on delete set null,
  first_at timestamptz,
  first_channel text, first_source text, first_campaign text, first_medium text,
  last_channel text, last_source text, last_campaign text, last_medium text,
  entry_page text,
  visits_before int not null default 0,
  -- « Comment m'avez-vous connu ? »
  declared_source text check (declared_source is null or char_length(declared_source) <= 60),
  declared_detail text check (declared_detail is null or char_length(declared_detail) <= 300),
  company_id uuid references public.companies (id) on delete set null,
  person_id uuid references public.people (id) on delete set null,
  demo boolean not null default false
);
create unique index if not exists site_attributions_booking on public.site_attributions (booking_id) where booking_id is not null;
create index if not exists site_attributions_converted on public.site_attributions (converted_at desc);
create index if not exists site_attributions_company on public.site_attributions (company_id) where company_id is not null;
create index if not exists site_attributions_visitor on public.site_attributions (visitor_id) where visitor_id is not null;
create index if not exists site_attributions_visit on public.site_attributions (visit_id) where visit_id is not null;

alter table public.site_attributions enable row level security;
revoke all on public.site_attributions from anon, authenticated;
grant select on public.site_attributions to authenticated;
drop policy if exists owner_select on public.site_attributions;
create policy owner_select on public.site_attributions for select to authenticated using ((select public.is_app_owner()));

-- ---------------------------------------------------------------------------
-- Source de la fiche : première source mesurée → source du lead (créée si elle n'existe pas encore)
-- ---------------------------------------------------------------------------
create or replace function site_private.lead_source_for(p_channel text, p_source text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_name text; v_id uuid;
begin
  v_name := case
    when p_source = 'linkedin' then 'LinkedIn'
    when p_channel = 'campaign' and p_source in ('email', 'newsletter', 'signature') then 'Email'
    when p_channel = 'campaign' and p_source = 'prospection' then 'Email sortant'
    when p_channel = 'campaign' then 'Campagne'
    when p_channel = 'organic' then 'Recherche organique'
    when p_channel = 'ai' then 'IA générative'
    when p_channel = 'social' then 'Réseaux sociaux'
    when p_channel = 'email' then 'Email'
    when p_channel = 'paid' then 'Publicité'
    when p_channel = 'referral' then 'Site référent'
    when p_channel = 'direct' then 'Site web'
    else null end;
  if v_name is null then return null; end if;
  select id into v_id from public.lead_sources where lower(btrim(name)) = lower(v_name);
  if v_id is null then
    insert into public.lead_sources (name, position)
    values (v_name, coalesce((select max(position) + 1 from public.lead_sources), 0))
    on conflict do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.lead_sources where lower(btrim(name)) = lower(v_name); end if;
  end if;
  return v_id;
end;
$$;

-- Recopie la fiche du rendez-vous sur l'attribution et remplit la source de la fiche si elle est vide.
create or replace function site_private.apply_fiche(p_booking uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare a public.site_attributions; v_company uuid; v_person uuid;
begin
  select * into a from public.site_attributions where booking_id = p_booking;
  if not found then return; end if;
  select company_id, person_id into v_company, v_person from public.appt_bookings where id = p_booking;
  if v_company is null then return; end if;
  update public.site_attributions set company_id = v_company, person_id = v_person
   where id = a.id and (company_id is distinct from v_company or person_id is distinct from v_person);
  -- jamais de remplacement : seule une source vide est remplie
  if a.first_channel is not null then
    update public.companies set source_id = site_private.lead_source_for(a.first_channel, a.first_source)
     where id = v_company and source_id is null;
  end if;
end;
$$;

/**
 * Rattache un rendez-vous de la réservation publique à la visite du site pendant laquelle il a été pris.
 * Sans visite connue (réservation ouverte directement), seule la source déclarée est gardée.
 */
create or replace function public.site_attach_booking(p_server_key text, p_booking uuid, p_visit uuid default null,
  p_visitor uuid default null, p_declared_source text default null, p_declared_detail text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.site_visits; f public.site_visits; l public.site_visits;
  v_visitor uuid; v_before int := 0;
  v_ds text := nullif(left(btrim(p_declared_source), 60), '');
  v_dd text := nullif(left(btrim(p_declared_detail), 300), '');
begin
  perform appt_private.assert_server(p_server_key);
  if not exists (select 1 from public.appt_bookings where id = p_booking) then return 'ignored'; end if;
  if exists (select 1 from public.site_attributions where booking_id = p_booking) then return 'existing'; end if;

  select * into v from public.site_visits where id = p_visit;
  if found then
    -- l'identifiant n'est retenu que s'il est celui de la visite (consentement donné) : jamais sur simple déclaration
    v_visitor := v.visitor_id;
    l := v;
    f := v;
    if v_visitor is not null then
      select * into f from public.site_visits where visitor_id = v_visitor order by started_at, id limit 1;
      select count(*) into v_before from public.site_visits where visitor_id = v_visitor and id <> v.id;
      update public.site_visitors set email_norm = coalesce(email_norm, (select email_norm from public.appt_bookings where id = p_booking))
       where id = v_visitor;
    end if;
  elsif v_ds is null and v_dd is null then
    return 'ignored';
  end if;

  insert into public.site_attributions (booking_id, visit_id, visitor_id, first_visit_id, first_at,
    first_channel, first_source, first_campaign, first_medium, last_channel, last_source, last_campaign, last_medium,
    entry_page, visits_before, declared_source, declared_detail)
  values (p_booking, l.id, v_visitor, f.id, f.started_at,
    f.channel, f.source, f.utm_campaign, f.utm_medium, l.channel, l.source, l.utm_campaign, l.utm_medium,
    f.entry_page, v_before, v_ds, v_dd)
  on conflict do nothing;
  perform site_private.apply_fiche(p_booking);
  return 'ok';
end;
$$;

revoke execute on function public.site_attach_booking(text, uuid, uuid, uuid, text, text) from public;
grant execute on function public.site_attach_booking(text, uuid, uuid, uuid, text, text) to anon, authenticated;

-- La fiche est souvent rattachée après la réservation (confirmation, ou rattachement à la main) : on suit.
create or replace function site_private.tg_booking_fiche()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.company_id is not null then perform site_private.apply_fiche(new.id); end if;
  return null;
end;
$$;
drop trigger if exists site_booking_fiche on public.appt_bookings;
create trigger site_booking_fiche after update of company_id, person_id on public.appt_bookings
  for each row when (new.company_id is distinct from old.company_id or new.person_id is distinct from old.person_id)
  execute function site_private.tg_booking_fiche();

-- ---------------------------------------------------------------------------
-- Lectures (exécutées avec les droits de l'appelant : la RLS réserve tout au propriétaire)
-- ---------------------------------------------------------------------------

-- Un rendez-vous compte tant qu'il n'est ni annulé, ni en échec, ni expiré.
create or replace view public.site_conversions with (security_invoker = true) as
select a.*, coalesce(b.company_id, a.company_id) as fiche_company_id, coalesce(b.person_id, a.person_id) as fiche_person_id,
       b.starts_at as booking_starts_at, b.status as booking_status,
       (a.booking_id is null or b.status in ('pending', 'confirmed')) as counted
  from public.site_attributions a
  left join public.appt_bookings b on b.id = a.booking_id;

-- Visiteurs consentants reliés à une fiche : par leur rendez-vous, sinon par l'adresse donnée dans un formulaire.
create or replace view public.site_identified with (security_invoker = true) as
select distinct on (u.id) u.id as visitor_id, coalesce(c.fiche_company_id, p.company_id) as company_id, coalesce(c.fiche_person_id, p.id) as person_id
  from public.site_visitors u
  left join public.site_conversions c on c.visitor_id = u.id and c.fiche_company_id is not null
  left join public.people p on u.email_norm is not null and p.email_norm = u.email_norm
 where coalesce(c.fiche_company_id, p.company_id) is not null
 order by u.id, c.converted_at nulls last, p.created_at;

revoke all on public.site_conversions, public.site_identified from anon, authenticated;
grant select on public.site_conversions, public.site_identified to authenticated;

/** Parcours site d'une fiche : première et dernière source, visites (UTM, pages, temps), rendez-vous, source déclarée. */
create or replace function public.site_company_journey(p_company uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with conv as (
    select c.* from public.site_conversions c where c.fiche_company_id = p_company
  ),
  visitors as (
    select visitor_id, person_id from public.site_identified where company_id = p_company
  ),
  visits as (
    select v.*, (select i.person_id from visitors i where i.visitor_id = v.visitor_id) as person_id
      from public.site_visits v
     where v.visitor_id in (select visitor_id from visitors)
        or v.id in (select visit_id from conv where visit_id is not null)
  ),
  first_touch as (select * from visits order by started_at, id limit 1)
  select jsonb_build_object(
    'first', (select jsonb_build_object('at', started_at, 'channel', channel, 'source', source, 'campaign', utm_campaign, 'medium', utm_medium, 'entry_page', entry_page) from first_touch),
    'last', (select jsonb_build_object('at', coalesce(v.started_at, c.converted_at), 'channel', c.last_channel, 'source', c.last_source, 'campaign', c.last_campaign, 'medium', c.last_medium)
               from conv c left join public.site_visits v on v.id = c.visit_id
              where c.last_channel is not null order by c.converted_at desc limit 1),
    'declared', coalesce((select jsonb_agg(jsonb_build_object('source', d.declared_source, 'detail', d.declared_detail, 'at', d.at) order by d.at)
                  from (
                    select declared_source, declared_detail, converted_at as at from conv where declared_source is not null or declared_detail is not null
                    union all
                    select e.declared_source, e.declared_detail, e.at from public.site_events e
                     where e.visit_id in (select id from visits) and (e.declared_source is not null or e.declared_detail is not null)
                  ) d), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'at', v.started_at, 'channel', v.channel, 'source', v.source, 'referrer_host', v.referrer_host,
        'utm', jsonb_strip_nulls(jsonb_build_object('source', v.utm_source, 'medium', v.utm_medium, 'campaign', v.utm_campaign, 'content', v.utm_content, 'term', v.utm_term)),
        'device', v.device, 'country', v.country, 'duration_s', v.duration_s, 'pageviews', v.pageviews, 'person_id', v.person_id,
        'pages', coalesce((select jsonb_agg(jsonb_build_object('path', p.path, 'at', p.at, 'duration_s', p.duration_s, 'scroll_pct', p.scroll_pct) order by p.at, p.id)
                             from public.site_pageviews p where p.visit_id = v.id), '[]'::jsonb),
        'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.at, 'path', e.path, 'label', e.label) order by e.at, e.id)
                              from public.site_events e where e.visit_id = v.id), '[]'::jsonb)
      ) order by v.started_at, v.id) from visits v), '[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object(
        'booking_id', c.booking_id, 'visit_id', c.visit_id, 'at', c.converted_at, 'starts_at', c.booking_starts_at, 'status', c.booking_status,
        'counted', c.counted, 'person_id', c.fiche_person_id) order by c.converted_at) from conv c), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')))
                 from public.people p
                where p.company_id = p_company
                  and (p.id in (select person_id from visitors) or p.id in (select fiche_person_id from conv))), '[]'::jsonb)
  );
$$;

/**
 * Aujourd'hui : prospects identifiés revenus sur le site ces p_days derniers jours, après leur premier rendez-vous
 * ou leur formulaire. « intent » : au moins une page à forte intention (offres, tarifs, réservation, contact).
 */
create or replace function public.site_return_signals(p_days int default 7)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ident as (
    select i.visitor_id, i.company_id,
           least((select min(c.converted_at) from public.site_conversions c where c.visitor_id = i.visitor_id),
                 (select min(e.at) from public.site_events e join public.site_visits v on v.id = e.visit_id
                   where v.visitor_id = i.visitor_id and e.kind = 'form')) as known_at
      from public.site_identified i
  ),
  back as (
    select i.company_id, v.id, v.started_at, v.pageviews,
           exists (select 1 from public.site_pageviews p
                    where p.visit_id = v.id and p.path ~* '(^/services|^/contact|^/audit|^/rdv|tarif|offre|prix|devis)') as intent,
           (select p.path from public.site_pageviews p
             where p.visit_id = v.id and p.path ~* '(^/services|^/contact|^/audit|^/rdv|tarif|offre|prix|devis)' order by p.at limit 1) as intent_page
      from ident i
      join public.site_visits v on v.visitor_id = i.visitor_id
     where v.started_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90))
       and i.known_at is not null and v.started_at > i.known_at + interval '1 hour'
  )
  select coalesce(jsonb_agg(row order by (row ->> 'intent')::boolean desc, row ->> 'last_at' desc), '[]'::jsonb)
    from (
      select jsonb_build_object('company_id', c.id, 'company_name', c.name, 'visits', count(*), 'last_at', max(b.started_at),
               'intent', bool_or(b.intent), 'intent_page', (array_agg(b.intent_page order by b.started_at desc) filter (where b.intent_page is not null))[1]) as row
        from back b join public.companies c on c.id = b.company_id
       where c.merged_into_id is null and c.archived_at is null
       group by c.id, c.name
    ) s;
$$;

revoke execute on function public.site_company_journey(uuid), public.site_return_signals(int) from public, anon;
grant execute on function public.site_company_journey(uuid), public.site_return_signals(int) to authenticated;
revoke execute on all functions in schema site_private from public, anon, authenticated;
