-- Tracking site · lot 6 : agrégats de l'espace Tracking site.
--
-- Tous les calculs sont faits ici, côté base : le navigateur ne reçoit que des agrégats, même avec un an de données.
-- Les fonctions s'exécutent avec les droits de l'appelant : la RLS réserve chaque ligne au propriétaire (un autre
-- compte obtient des agrégats vides). Les périodes sont des jours de Paris, bornes comprises.
-- Filtres (p_f) : channel, source, campaign, page, country, device. Rejouable.

-- Visites de la période qui passent les filtres.
create or replace function public.site_f_visits(p_from date, p_to date, p_f jsonb)
returns setof public.site_visits
language sql
stable
set search_path = ''
as $$
  select v.*
    from public.site_visits v
   where v.started_at >= (p_from::timestamp at time zone 'Europe/Paris')
     and v.started_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')
     and (nullif(p_f ->> 'channel', '') is null or v.channel = p_f ->> 'channel')
     and (nullif(p_f ->> 'source', '') is null or v.source = p_f ->> 'source')
     and (nullif(p_f ->> 'campaign', '') is null or v.utm_campaign = p_f ->> 'campaign')
     and (nullif(p_f ->> 'country', '') is null or v.country = p_f ->> 'country')
     and (nullif(p_f ->> 'device', '') is null or v.device = p_f ->> 'device')
     and (nullif(p_f ->> 'page', '') is null or exists (
           select 1 from public.site_pageviews p where p.visit_id = v.id and p.path = p_f ->> 'page'));
$$;

-- Rendez-vous comptés de la période (ni annulés ni en échec) ; avec un filtre, seuls ceux dont la visite le passe.
create or replace function public.site_f_conversions(p_from date, p_to date, p_f jsonb)
returns setof public.site_conversions
language sql
stable
set search_path = ''
as $$
  select c.*
    from public.site_conversions c
    left join public.site_visits v on v.id = c.visit_id
   where c.counted
     and c.converted_at >= (p_from::timestamp at time zone 'Europe/Paris')
     and c.converted_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')
     and (nullif(p_f ->> 'channel', '') is null or v.channel = p_f ->> 'channel')
     and (nullif(p_f ->> 'source', '') is null or v.source = p_f ->> 'source')
     and (nullif(p_f ->> 'campaign', '') is null or v.utm_campaign = p_f ->> 'campaign')
     and (nullif(p_f ->> 'country', '') is null or v.country = p_f ->> 'country')
     and (nullif(p_f ->> 'device', '') is null or v.device = p_f ->> 'device')
     and (nullif(p_f ->> 'page', '') is null or exists (
           select 1 from public.site_pageviews p where p.visit_id = v.id and p.path = p_f ->> 'page'));
$$;

-- Pas des courbes : le jour jusqu'à trois mois, la semaine au-delà (une année = 53 points).
create or replace function public.site_bucket(p_from date, p_to date)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p_to - p_from <= 92 then 'day' else 'week' end; $$;

create or replace function public.site_day(p_at timestamptz, p_bucket text)
returns date
language sql
immutable
set search_path = ''
as $$ select date_trunc(p_bucket, p_at at time zone 'Europe/Paris')::date; $$;

-- Chiffres clés d'une période : visiteurs (un visiteur anonyme compte pour une visite), visites, rendez-vous…
create or replace function public.site_kpis(p_from date, p_to date, p_f jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'visits', v.visits, 'visitors', v.visitors, 'ai_visits', v.ai, 'cta_visits', v.cta, 'pageviews', v.pageviews,
    'bookings', c.n,
    'rate', case when v.visits > 0 then round(100.0 * c.n / v.visits, 2) else 0 end)
  from (select count(*) as visits, count(distinct coalesce(visitor_id, id)) as visitors,
               count(*) filter (where channel = 'ai') as ai, count(*) filter (where cta_clicks > 0) as cta,
               coalesce(sum(pageviews), 0) as pageviews
          from public.site_f_visits(p_from, p_to, p_f)) v,
       (select count(*) as n from public.site_f_conversions(p_from, p_to, p_f)) c;
$$;

-- Courbe de la période : par pas, visites par source, visiteurs, rendez-vous. Les pas sans donnée valent zéro.
create or replace function public.site_series(p_from date, p_to date, p_f jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with params as (select public.site_bucket(p_from, p_to) as b),
  steps as (
    select generate_series(date_trunc(b, p_from::timestamp), p_to::timestamp, ('1 ' || b)::interval)::date as d from params
  ),
  vis as (
    select public.site_day(v.started_at, (select b from params)) as d, v.channel, count(*) as n,
           count(distinct coalesce(v.visitor_id, v.id)) as u
      from public.site_f_visits(p_from, p_to, p_f) v group by 1, 2
  ),
  tot as (
    select public.site_day(v.started_at, (select b from params)) as d, count(distinct coalesce(v.visitor_id, v.id)) as u
      from public.site_f_visits(p_from, p_to, p_f) v group by 1
  ),
  conv as (
    select public.site_day(c.converted_at, (select b from params)) as d, count(*) as n
      from public.site_f_conversions(p_from, p_to, p_f) c group by 1
  )
  select jsonb_build_object('bucket', (select b from params), 'points', coalesce(jsonb_agg(jsonb_build_object(
      'd', s.d,
      'visits', coalesce((select sum(n) from vis where vis.d = s.d), 0),
      'visitors', coalesce((select u from tot where tot.d = s.d), 0),
      'bookings', coalesce((select n from conv where conv.d = s.d), 0),
      'by', coalesce((select jsonb_object_agg(channel, n) from vis where vis.d = s.d), '{}'::jsonb)
    ) order by s.d), '[]'::jsonb))
  from steps s;
$$;

/** Vue d'ensemble : chiffres clés (période et période précédente de même durée), courbe, entonnoir. */
create or replace function public.site_stats_overview(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'previous_from', p_from - (p_to - p_from + 1), 'previous_to', p_from - 1,
    'kpis', public.site_kpis(p_from, p_to, p_f),
    'previous', public.site_kpis(p_from - (p_to - p_from + 1), p_from - 1, p_f),
    'series', public.site_series(p_from, p_to, p_f),
    'has_data', exists (select 1 from public.site_visits));
$$;

/** En direct : visites actives ces cinq dernières minutes et pages en cours de lecture. */
create or replace function public.site_live()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'visitors', count(*),
    'pages', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'n', n) order by n desc, path)
                         from (select exit_page as path, count(*) as n from public.site_visits
                                where last_seen_at > now() - interval '5 minutes' group by 1 order by 2 desc limit 5) p), '[]'::jsonb))
    from public.site_visits where last_seen_at > now() - interval '5 minutes';
$$;

/** Sources : répartition, rendez-vous en première et en dernière source, sites référents, déclaré contre mesuré. */
create or replace function public.site_stats_sources(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_f_visits(p_from, p_to, p_f)),
  pv as (select * from public.site_f_visits(p_from - (p_to - p_from + 1), p_from - 1, p_f)),
  c as (select * from public.site_f_conversions(p_from, p_to, p_f)),
  channels as (
    select ch.channel,
           (select count(*) from v where v.channel = ch.channel) as visits,
           (select count(distinct coalesce(visitor_id, id)) from v where v.channel = ch.channel) as visitors,
           (select count(*) from pv where pv.channel = ch.channel) as previous_visits,
           (select count(*) from c where c.first_channel = ch.channel) as bookings_first,
           (select count(*) from c where c.last_channel = ch.channel) as bookings_last
      from unnest(array['direct','campaign','organic','social','email','referral','ai','paid']) as ch(channel)
  ),
  details as (
    select g.*,
           (select count(*) from c where c.first_channel = g.channel and coalesce(c.first_source, '') = g.source) as bookings_first,
           (select count(*) from c where c.last_channel = g.channel and coalesce(c.last_source, '') = g.source) as bookings_last
      from (select v.channel, coalesce(v.source, '') as source, count(*) as visits, count(distinct coalesce(v.visitor_id, v.id)) as visitors
              from v group by 1, 2) g
  ),
  referrers as (
    select g.*, (select count(*) from c join public.site_visits lv on lv.id = c.visit_id where lv.referrer_host = g.host) as bookings
      from (select v.referrer_host as host, count(*) as visits, count(distinct coalesce(v.visitor_id, v.id)) as visitors
              from v where v.channel = 'referral' and v.referrer_host is not null group by 1) g
  ),
  decl as (
    select coalesce(c.declared_source, 'Non renseignée') as declared, coalesce(c.first_channel, 'unknown') as measured, count(*) as n
      from c group by 1, 2
  )
  select jsonb_build_object(
    'channels', (select jsonb_agg(to_jsonb(channels)) from channels),
    'details', coalesce((select jsonb_agg(to_jsonb(d) order by d.visits desc, d.source) from (select * from details order by visits desc limit 60) d), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(to_jsonb(r) order by r.visits desc, r.host) from (select * from referrers order by visits desc limit 40) r), '[]'::jsonb),
    'declared', coalesce((select jsonb_agg(to_jsonb(decl) order by decl.n desc) from decl), '[]'::jsonb),
    'bookings', (select count(*) from c),
    'series', public.site_series(p_from, p_to, p_f));
$$;

/** Campagnes : performances de chaque campagne et de chaque lien UTM, courbes des campagnes les plus actives. */
create or replace function public.site_stats_campaigns(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_f_visits(p_from, p_to, p_f) where channel = 'campaign'),
  c as (select c.*, lv.utm_source as v_source, lv.utm_medium as v_medium, lv.utm_campaign as v_campaign, lv.utm_content as v_content
          from public.site_f_conversions(p_from, p_to, p_f) c join public.site_visits lv on lv.id = c.visit_id),
  campaigns as (
    select g.*,
           (select count(*) from c where coalesce(c.v_campaign, '(sans nom)') = g.campaign) as bookings,
           (select count(*) from public.site_conversions fc
             where fc.counted and fc.first_channel = 'campaign' and coalesce(fc.first_campaign, '(sans nom)') = g.campaign
               and fc.converted_at >= (p_from::timestamp at time zone 'Europe/Paris')
               and fc.converted_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')) as bookings_first
      from (select coalesce(v.utm_campaign, '(sans nom)') as campaign, count(*) as visits, count(distinct coalesce(v.visitor_id, v.id)) as visitors,
                   sum(v.pageviews) as pageviews, round(avg(v.duration_s)) as avg_duration,
                   array_agg(distinct v.utm_source) filter (where v.utm_source is not null) as sources,
                   array_agg(distinct v.utm_medium) filter (where v.utm_medium is not null) as mediums
              from v group by 1) g
  ),
  links as (
    select l.id, l.name, l.url, l.path, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.created_at,
           lv.visits, lv.visitors, lv.pageviews,
           (select count(*) from c where c.v_source = l.utm_source and c.v_medium = l.utm_medium and c.v_campaign = l.utm_campaign
               and (l.utm_content is null or c.v_content = l.utm_content)) as bookings
      from public.site_utm_links l
      cross join lateral (
        select count(*) as visits, count(distinct coalesce(v.visitor_id, v.id)) as visitors, coalesce(sum(v.pageviews), 0) as pageviews
          from v where v.utm_source = l.utm_source and v.utm_medium = l.utm_medium and v.utm_campaign = l.utm_campaign
                   and (l.utm_content is null or v.utm_content = l.utm_content)) lv
  ),
  top as (select campaign from campaigns order by visits desc, campaign limit 6),
  b as (select public.site_bucket(p_from, p_to) as b),
  steps as (select generate_series(date_trunc(b, p_from::timestamp), p_to::timestamp, ('1 ' || b)::interval)::date as d from b),
  pts as (
    select public.site_day(v.started_at, (select b from b)) as d, coalesce(v.utm_campaign, '(sans nom)') as campaign, count(*) as n
      from v where coalesce(v.utm_campaign, '(sans nom)') in (select campaign from top) group by 1, 2
  )
  select jsonb_build_object(
    'campaigns', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc, x.campaign) from (select * from campaigns order by visits desc limit 100) x), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(to_jsonb(links) order by links.created_at desc) from links), '[]'::jsonb),
    'top', coalesce((select jsonb_agg(campaign) from top), '[]'::jsonb),
    'series', jsonb_build_object('bucket', (select b from b), 'points', coalesce((select jsonb_agg(jsonb_build_object(
        'd', s.d, 'by', coalesce((select jsonb_object_agg(campaign, n) from pts where pts.d = s.d), '{}'::jsonb)) order by s.d) from steps s), '[]'::jsonb)));
$$;

/** Pages : entrées, vues, temps passé, défilement, pages qui convertissent et pages qui font fuir. */
create or replace function public.site_stats_pages(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_f_visits(p_from, p_to, p_f)),
  c as (select * from public.site_f_conversions(p_from, p_to, p_f)),
  views as (
    select p.path, count(*) as views, count(distinct p.visit_id) as visits, round(avg(p.duration_s)) as avg_duration,
           round(avg(p.scroll_pct)) as avg_scroll,
           count(distinct p.visit_id) filter (where p.visit_id in (select visit_id from c)) as converting_visits
      from public.site_pageviews p join v on v.id = p.visit_id group by p.path
  ),
  entries as (select entry_page as path, count(*) as entries, count(*) filter (where pageviews = 1) as bounces from v group by 1),
  exits as (select exit_page as path, count(*) as exits from v group by 1)
  select jsonb_build_object('pages', coalesce((select jsonb_agg(jsonb_build_object(
      'path', w.path, 'views', w.views, 'visits', w.visits, 'avg_duration', w.avg_duration, 'avg_scroll', w.avg_scroll,
      'entries', coalesce(e.entries, 0), 'bounces', coalesce(e.bounces, 0), 'exits', coalesce(x.exits, 0),
      'exit_rate', case when w.visits > 0 then round(100.0 * coalesce(x.exits, 0) / w.visits, 1) else 0 end,
      'bookings', w.converting_visits,
      'rate', case when w.visits > 0 then round(100.0 * w.converting_visits / w.visits, 2) else 0 end
    ) order by w.views desc, w.path) from (select * from views order by views desc limit 200) w
      left join entries e on e.path = w.path left join exits x on x.path = w.path), '[]'::jsonb),
    'visits', (select count(*) from v));
$$;

/** Prospects : visiteurs identifiés et convertis, première et dernière source, visites, rendez-vous. */
create or replace function public.site_stats_prospects(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with conv as (
    select c.id, c.visitor_id, c.visit_id, c.converted_at, c.booking_starts_at, c.booking_status, c.counted, c.fiche_company_id as company_id,
           c.fiche_person_id as person_id, c.first_channel, c.first_source, c.first_campaign, c.last_channel, c.last_source, c.last_campaign,
           c.declared_source
      from public.site_conversions c
      left join public.site_visits v on v.id = c.visit_id
     where c.converted_at >= (p_from::timestamp at time zone 'Europe/Paris')
       and c.converted_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')
       and (nullif(p_f ->> 'channel', '') is null or v.channel = p_f ->> 'channel' or c.first_channel = p_f ->> 'channel')
       and (nullif(p_f ->> 'campaign', '') is null or v.utm_campaign = p_f ->> 'campaign' or c.first_campaign = p_f ->> 'campaign')
       and (nullif(p_f ->> 'country', '') is null or v.country = p_f ->> 'country')
       and (nullif(p_f ->> 'device', '') is null or v.device = p_f ->> 'device')
  ),
  -- visiteurs identifiés par un formulaire, sans rendez-vous sur la période
  leads as (
    select i.visitor_id, i.company_id, i.person_id
      from public.site_identified i
     where not exists (select 1 from conv where conv.visitor_id = i.visitor_id)
       and exists (select 1 from public.site_f_visits(p_from, p_to, p_f) v where v.visitor_id = i.visitor_id)
  ),
  rows as (
    select conv.id::text as key, conv.company_id, conv.person_id, conv.visitor_id, conv.converted_at, conv.booking_starts_at, conv.booking_status,
           conv.counted, true as booked, conv.first_channel, conv.first_source, conv.first_campaign, conv.last_channel, conv.last_source,
           conv.last_campaign, conv.declared_source
      from conv
    union all
    select l.visitor_id::text, l.company_id, l.person_id, l.visitor_id, null, null, null, false, false,
           f.channel, f.source, f.utm_campaign, la.channel, la.source, la.utm_campaign, null
      from leads l
      left join lateral (select * from public.site_visits v where v.visitor_id = l.visitor_id order by started_at, id limit 1) f on true
      left join lateral (select * from public.site_visits v where v.visitor_id = l.visitor_id order by started_at desc, id desc limit 1) la on true
  )
  select jsonb_build_object('prospects', coalesce(jsonb_agg(jsonb_build_object(
      'key', r.key, 'company_id', r.company_id, 'company_name', co.name,
      'person_name', nullif(btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')), ''),
      'booked', r.booked, 'counted', r.counted, 'converted_at', r.converted_at, 'booking_starts_at', r.booking_starts_at, 'booking_status', r.booking_status,
      'first', jsonb_build_object('channel', r.first_channel, 'source', r.first_source, 'campaign', r.first_campaign),
      'last', jsonb_build_object('channel', r.last_channel, 'source', r.last_source, 'campaign', r.last_campaign),
      'declared_source', r.declared_source,
      'visits', case when r.visitor_id is not null then (select count(*) from public.site_visits v where v.visitor_id = r.visitor_id) else 1 end,
      'last_visit_at', case when r.visitor_id is not null then (select max(started_at) from public.site_visits v where v.visitor_id = r.visitor_id)
                            else r.converted_at end
    ) order by coalesce(r.converted_at, now()) desc), '[]'::jsonb))
    from (select * from rows order by converted_at desc nulls last limit 300) r
    left join public.companies co on co.id = r.company_id
    left join public.people pe on pe.id = r.person_id;
$$;

-- ---------------------------------------------------------------------------
-- SEO. Search Console n'écrit que des lignes page × requête ; Bing écrit quatre niveaux (site, requête, page,
-- page × requête) qu'il ne faut jamais additionner entre eux.
-- ---------------------------------------------------------------------------
create or replace view public.seo_queries with (security_invoker = true) as
  select provider, day, query, sum(clicks) as clicks, sum(impressions) as impressions,
         sum(position * impressions) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from public.seo_daily
   where query <> '' and ((provider = 'gsc' and page <> '') or (provider <> 'gsc' and page = ''))
   group by provider, day, query;

create or replace view public.seo_pages with (security_invoker = true) as
  select provider, day, page, sum(clicks) as clicks, sum(impressions) as impressions,
         sum(position * impressions) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from public.seo_daily
   where page <> '' and ((provider = 'gsc' and query <> '') or (provider <> 'gsc' and query = ''))
   group by provider, day, page;

create or replace view public.seo_totals with (security_invoker = true) as
  select provider, day, sum(clicks) as clicks, sum(impressions) as impressions,
         sum(position * impressions) / nullif(sum(impressions) filter (where position is not null), 0) as position
    from public.seo_daily
   where (provider = 'gsc' and page <> '' and query <> '') or (provider <> 'gsc' and page = '' and query = '')
   group by provider, day;

revoke all on public.seo_queries, public.seo_pages, public.seo_totals from anon, authenticated;
grant select on public.seo_queries, public.seo_pages, public.seo_totals to authenticated;

/**
 * SEO : mots-clés Google et Bing (clics, impressions, position et tendance), courbe des clics, pages, et
 * rapprochement mot-clé → page → rendez-vous (rendez-vous des visites de recherche organique entrées par la page).
 * p_f : provider (gsc | bing), page, query (courbe de position de ce mot-clé).
 */
create or replace function public.site_stats_seo(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with prm as (select nullif(p_f ->> 'provider', '') as provider, nullif(p_f ->> 'page', '') as page, nullif(p_f ->> 'query', '') as query,
                      p_from - (p_to - p_from + 1) as pfrom, p_from - 1 as pto),
  q as (
    select s.provider, s.query, sum(s.clicks) as clicks, sum(s.impressions) as impressions,
           round((sum(s.position * s.impressions) / nullif(sum(s.impressions) filter (where s.position is not null), 0))::numeric, 1) as position
      from public.seo_queries s, prm
     where s.day between p_from and p_to and (prm.provider is null or s.provider = prm.provider)
       and (prm.page is null or exists (select 1 from public.seo_daily d where d.provider = s.provider and d.query = s.query and d.page = prm.page and d.day between p_from and p_to))
     group by s.provider, s.query
  ),
  qp as (
    select s.provider, s.query, sum(s.clicks) as clicks,
           round((sum(s.position * s.impressions) / nullif(sum(s.impressions) filter (where s.position is not null), 0))::numeric, 1) as position
      from public.seo_queries s, prm
     where s.day between prm.pfrom and prm.pto and (prm.provider is null or s.provider = prm.provider)
     group by s.provider, s.query
  ),
  best as (
    select distinct on (d.provider, d.query) d.provider, d.query, d.page
      from public.seo_daily d, prm
     where d.day between p_from and p_to and d.page <> '' and d.query <> '' and (prm.provider is null or d.provider = prm.provider)
     group by d.provider, d.query, d.page
     order by d.provider, d.query, sum(d.clicks) desc, sum(d.impressions) desc
  ),
  organic as (
    select v.entry_page as page, count(*) as visits,
           count(*) filter (where v.id in (select visit_id from public.site_f_conversions(p_from, p_to, '{}'::jsonb))) as bookings
      from public.site_f_visits(p_from, p_to, '{"channel":"organic"}'::jsonb) v group by v.entry_page
  ),
  pages as (
    select s.provider, s.page, sum(s.clicks) as clicks, sum(s.impressions) as impressions,
           round((sum(s.position * s.impressions) / nullif(sum(s.impressions) filter (where s.position is not null), 0))::numeric, 1) as position
      from public.seo_pages s, prm
     where s.day between p_from and p_to and (prm.provider is null or s.provider = prm.provider)
     group by s.provider, s.page
  ),
  b as (select public.site_bucket(p_from, p_to) as b),
  steps as (select generate_series(date_trunc(b, p_from::timestamp), p_to::timestamp, ('1 ' || b)::interval)::date as d from b),
  tot as (
    select date_trunc((select b from b), t.day::timestamp)::date as d, t.provider, sum(t.clicks) as clicks, sum(t.impressions) as impressions
      from public.seo_totals t, prm
     where t.day between p_from and p_to and (prm.provider is null or t.provider = prm.provider) group by 1, 2
  ),
  pos as (
    select date_trunc((select b from b), s.day::timestamp)::date as d, s.provider,
           round((sum(s.position * s.impressions) / nullif(sum(s.impressions) filter (where s.position is not null), 0))::numeric, 1) as position,
           sum(s.clicks) as clicks, sum(s.impressions) as impressions
      from public.seo_queries s, prm
     where prm.query is not null and s.query = prm.query and s.day between p_from and p_to group by 1, 2
  )
  select jsonb_build_object(
    'connections', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'status', status, 'site_url', site_url,
        'last_sync_at', last_sync_at, 'history_done', history_done_at is not null, 'last_error', last_error)) from public.seo_connections), '[]'::jsonb),
    'has_data', exists (select 1 from public.seo_daily),
    'totals', jsonb_build_object(
      'clicks', coalesce((select sum(clicks) from tot), 0), 'impressions', coalesce((select sum(impressions) from tot), 0),
      'previous_clicks', coalesce((select sum(t.clicks) from public.seo_totals t, prm where t.day between prm.pfrom and prm.pto and (prm.provider is null or t.provider = prm.provider)), 0),
      'previous_impressions', coalesce((select sum(t.impressions) from public.seo_totals t, prm where t.day between prm.pfrom and prm.pto and (prm.provider is null or t.provider = prm.provider)), 0)),
    'series', jsonb_build_object('bucket', (select b from b), 'points', coalesce((select jsonb_agg(jsonb_build_object(
        'd', s.d, 'by', coalesce((select jsonb_object_agg(provider, clicks) from tot where tot.d = s.d), '{}'::jsonb),
        'impressions', coalesce((select sum(impressions) from tot where tot.d = s.d), 0)) order by s.d) from steps s), '[]'::jsonb)),
    'queries', coalesce((select jsonb_agg(jsonb_build_object(
        'provider', x.provider, 'query', x.query, 'clicks', x.clicks, 'impressions', x.impressions, 'position', x.position,
        'ctr', case when x.impressions > 0 then round(100.0 * x.clicks / x.impressions, 1) else 0 end,
        'previous_position', (select position from qp where qp.provider = x.provider and qp.query = x.query),
        'previous_clicks', (select clicks from qp where qp.provider = x.provider and qp.query = x.query),
        'page', (select page from best where best.provider = x.provider and best.query = x.query),
        'page_bookings', (select o.bookings from organic o join best on best.page = o.page where best.provider = x.provider and best.query = x.query)
      ) order by x.clicks desc, x.impressions desc, x.query)
      from (select * from q order by clicks desc, impressions desc limit 250) x), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(jsonb_build_object(
        'provider', x.provider, 'page', x.page, 'clicks', x.clicks, 'impressions', x.impressions, 'position', x.position,
        'visits', coalesce((select o.visits from organic o where o.page = x.page), 0),
        'bookings', coalesce((select o.bookings from organic o where o.page = x.page), 0),
        'queries', (select count(distinct d.query) from public.seo_daily d where d.provider = x.provider and d.page = x.page and d.query <> '' and d.day between p_from and p_to)
      ) order by x.clicks desc, x.impressions desc, x.page)
      from (select * from pages order by clicks desc, impressions desc limit 100) x), '[]'::jsonb),
    'query', (select query from prm),
    'positions', coalesce((select jsonb_agg(jsonb_build_object('d', s.d,
        'by', coalesce((select jsonb_object_agg(provider, position) from pos where pos.d = s.d and pos.position is not null), '{}'::jsonb),
        'clicks', coalesce((select sum(clicks) from pos where pos.d = s.d), 0)) order by s.d)
      from steps s where (select query from prm) is not null), '[]'::jsonb));
$$;

/** IA : visites venues de chaque IA générative et leurs rendez-vous ; robots (pages lues, fréquence, origine). */
create or replace function public.site_stats_ai(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_f_visits(p_from, p_to, p_f || '{"channel":"ai"}'::jsonb)),
  c as (select c.*, lv.source as v_source from public.site_f_conversions(p_from, p_to, p_f || '{"channel":"ai"}'::jsonb) c
          join public.site_visits lv on lv.id = c.visit_id),
  first_c as (
    select fc.first_source as source, count(*) as n from public.site_conversions fc
     where fc.counted and fc.first_channel = 'ai'
       and fc.converted_at >= (p_from::timestamp at time zone 'Europe/Paris') and fc.converted_at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')
     group by 1
  ),
  engines as (
    select g.*, (select count(*) from c where coalesce(c.v_source, 'autre') = g.source) as bookings
      from (select coalesce(v.source, 'autre') as source, count(*) as visits, count(distinct coalesce(v.visitor_id, v.id)) as visitors,
                   round(avg(v.duration_s)) as avg_duration, round(avg(v.pageviews), 1) as avg_pages
              from v group by 1) g
  ),
  landing as (select entry_page as path, count(*) as visits from v group by 1 order by 2 desc limit 15),
  b as (select public.site_bucket(p_from, p_to) as b),
  steps as (select generate_series(date_trunc(b, p_from::timestamp), p_to::timestamp, ('1 ' || b)::interval)::date as d from b),
  pts as (select public.site_day(v.started_at, (select b from b)) as d, coalesce(v.source, 'autre') as source, count(*) as n from v group by 1, 2),
  hits as (
    select h.* from public.site_bot_hits h
     where h.day between p_from and p_to and (nullif(p_f ->> 'page', '') is null or h.path = p_f ->> 'page')
  ),
  bots as (
    select bot, kind, sum(hits) as hits, sum(hits) filter (where status = 'verified') as verified,
           sum(hits) filter (where status = 'unverified') as unverified, sum(hits) filter (where status = 'unverifiable') as unverifiable,
           count(distinct path) as pages, count(distinct day) as days, max(last_at) as last_at
      from hits group by bot, kind
  ),
  bot_pages as (
    select bot, path, sum(hits) as hits, count(distinct day) as days, max(last_at) as last_at
      from hits where status <> 'unverified' group by bot, path
  ),
  bot_pts as (
    select date_trunc((select b from b), h.day::timestamp)::date as d, h.kind, sum(h.hits) as n
      from hits h where h.status <> 'unverified' group by 1, 2
  ),
  human_pages as (
    select p.path, count(*) as views from public.site_pageviews p
     where p.at >= (p_from::timestamp at time zone 'Europe/Paris') and p.at < ((p_to + 1)::timestamp at time zone 'Europe/Paris')
     group by p.path
  )
  select jsonb_build_object(
    'engines', coalesce((select jsonb_agg(jsonb_build_object('source', e.source, 'visits', e.visits, 'visitors', e.visitors, 'avg_duration', e.avg_duration,
        'avg_pages', e.avg_pages, 'bookings', e.bookings, 'bookings_first', coalesce((select n from first_c where coalesce(first_c.source, 'autre') = e.source), 0))
        order by e.visits desc, e.source) from engines e), '[]'::jsonb),
    'landing', coalesce((select jsonb_agg(to_jsonb(landing)) from landing), '[]'::jsonb),
    'series', jsonb_build_object('bucket', (select b from b), 'points', coalesce((select jsonb_agg(jsonb_build_object(
        'd', s.d, 'by', coalesce((select jsonb_object_agg(source, n) from pts where pts.d = s.d), '{}'::jsonb)) order by s.d) from steps s), '[]'::jsonb)),
    'bots', coalesce((select jsonb_agg(to_jsonb(bots) order by bots.hits desc, bots.bot) from bots), '[]'::jsonb),
    'bot_pages', coalesce((select jsonb_agg(to_jsonb(x) order by x.hits desc, x.path) from (select * from bot_pages order by hits desc limit 300) x), '[]'::jsonb),
    'bot_series', jsonb_build_object('bucket', (select b from b), 'points', coalesce((select jsonb_agg(jsonb_build_object(
        'd', s.d, 'by', coalesce((select jsonb_object_agg(kind, n) from bot_pts where bot_pts.d = s.d), '{}'::jsonb)) order by s.d) from steps s), '[]'::jsonb)),
    -- pages vues par des visiteurs mais jamais lues par un robot d'IA sur la période
    'unread', coalesce((select jsonb_agg(jsonb_build_object('path', hp.path, 'views', hp.views) order by hp.views desc)
        from (select * from human_pages hp where not exists (select 1 from hits h where h.kind = 'ai' and h.status <> 'unverified' and h.path = hp.path)
               order by views desc limit 20) hp), '[]'::jsonb),
    'has_bots', exists (select 1 from public.site_bot_hits));
$$;

/** Géographie : pays, appareils, navigateurs. */
create or replace function public.site_stats_geo(p_from date, p_to date, p_f jsonb default '{}')
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_f_visits(p_from, p_to, p_f)),
  c as (select c.*, lv.country as v_country, lv.device as v_device from public.site_f_conversions(p_from, p_to, p_f) c
          join public.site_visits lv on lv.id = c.visit_id)
  select jsonb_build_object(
    'visits', (select count(*) from v),
    'countries', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc, x.country) from (
        select g.*, (select count(*) from c where coalesce(c.v_country, '??') = g.country) as bookings
          from (select coalesce(country, '??') as country, count(*) as visits, count(distinct coalesce(visitor_id, id)) as visitors from v group by 1) g) x), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc) from (
        select g.*, (select count(*) from c where c.v_device = g.device) as bookings
          from (select device, count(*) as visits, round(avg(duration_s)) as avg_duration from v group by 1) g) x), '[]'::jsonb),
    'browsers', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc) from (
        select coalesce(browser, 'Autre') as browser, count(*) as visits from v group by 1) x), '[]'::jsonb),
    'returning', (select count(*) from v where is_returning));
$$;

/** Valeurs proposées par les filtres (campagnes, pages, pays présents sur les treize derniers mois). */
create or replace function public.site_filter_options()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with v as (select * from public.site_visits where started_at > now() - interval '13 months')
  select jsonb_build_object(
    'campaigns', coalesce((select jsonb_agg(x.c order by x.n desc) from (select utm_campaign as c, count(*) as n from v where utm_campaign is not null group by 1 order by 2 desc limit 100) x), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(x.p order by x.n desc) from (select entry_page as p, count(*) as n from v group by 1 order by 2 desc limit 100) x), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(x.c order by x.n desc) from (select country as c, count(*) as n from v where country is not null group by 1 order by 2 desc limit 60) x), '[]'::jsonb));
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.site_f_visits(date, date, jsonb)', 'public.site_f_conversions(date, date, jsonb)', 'public.site_bucket(date, date)',
    'public.site_day(timestamptz, text)', 'public.site_kpis(date, date, jsonb)', 'public.site_series(date, date, jsonb)',
    'public.site_stats_overview(date, date, jsonb)', 'public.site_live()', 'public.site_stats_sources(date, date, jsonb)',
    'public.site_stats_campaigns(date, date, jsonb)', 'public.site_stats_pages(date, date, jsonb)',
    'public.site_stats_prospects(date, date, jsonb)', 'public.site_stats_seo(date, date, jsonb)', 'public.site_stats_ai(date, date, jsonb)',
    'public.site_stats_geo(date, date, jsonb)', 'public.site_filter_options()']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
