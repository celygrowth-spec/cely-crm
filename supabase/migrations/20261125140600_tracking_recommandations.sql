-- Tracking site · lot 7 : bloc « À faire » de la Vue d'ensemble.
-- Quelques actions concrètes tirées des données de la période ; chacune porte de quoi renvoyer vers son détail.
-- Exécutée avec les droits de l'appelant (RLS : propriétaire seul). Rejouable.

create or replace function public.site_recommendations(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with len as (select p_to - p_from + 1 as n, p_from - (p_to - p_from + 1) as pfrom, p_from - 1 as pto),
  v as (select * from public.site_f_visits(p_from, p_to, '{}'::jsonb)),
  pv as (select * from public.site_f_visits((select pfrom from len), (select pto from len), '{}'::jsonb)),
  c as (select * from public.site_f_conversions(p_from, p_to, '{}'::jsonb)),
  -- 1. mots-clés en position 5 à 15 avec des impressions : un effort de contenu peut les faire monter
  kw as (
    select 'keyword' as kind, 10 as weight, jsonb_build_object('query', q.query, 'provider', q.provider, 'position', q.position, 'impressions', q.impressions,
             'clicks', q.clicks) as data
      from (select provider, query, sum(clicks) as clicks, sum(impressions) as impressions,
                   round((sum(position * impressions) / nullif(sum(impressions) filter (where position is not null), 0))::numeric, 1) as position
              from public.seo_queries where day between p_from and p_to group by 1, 2) q
     where q.position between 5 and 15 and q.impressions >= 20
     order by q.impressions desc limit 3
  ),
  -- 2. pages très visitées qui ne mènent à aucun rendez-vous
  page_stats as (
    select p.path, count(distinct p.visit_id) as visits,
           count(distinct p.visit_id) filter (where p.visit_id in (select visit_id from c)) as bookings
      from public.site_pageviews p join v on v.id = p.visit_id group by p.path
  ),
  pages as (
    select 'page' as kind, 20 as weight, jsonb_build_object('path', path, 'visits', visits) as data
      from page_stats
     where bookings = 0 and visits >= greatest(30, (select count(*) from v) / 20)
       and path !~* '(mentions|confidentialite|cookies|cgu|cgv)'
     order by visits desc limit 2
  ),
  -- 3. source ou campagne en forte hausse ou en forte baisse par rapport à la période précédente
  moves as (
    select 'trend' as kind, 30 as weight, jsonb_build_object('scope', x.scope, 'name', x.name, 'visits', x.cur, 'previous', x.prev,
             'change', round(100.0 * (x.cur - x.prev) / nullif(x.prev, 0))) as data
      from (
        select 'channel' as scope, ch as name, (select count(*) from v where channel = ch) as cur, (select count(*) from pv where channel = ch) as prev
          from unnest(array['direct','campaign','organic','social','email','referral','ai','paid']) ch
        union all
        select 'campaign', k.name, (select count(*) from v where utm_campaign = k.name), (select count(*) from pv where utm_campaign = k.name)
          from (select utm_campaign as name from v where utm_campaign is not null union select utm_campaign from pv where utm_campaign is not null) k
      ) x
     -- une période précédente presque vide ne dit rien d'une tendance
     where greatest(x.cur, x.prev) >= 20 and x.prev >= 10 and abs(x.cur - x.prev) >= 0.4 * x.prev
     order by abs(x.cur - x.prev) desc limit 3
  ),
  -- 4. visites arrivées depuis un réseau social ou une messagerie sans lien UTM : des liens partagés sans marquage
  untagged as (
    select 'untagged' as kind, 40 as weight, jsonb_build_object('channel', channel, 'source', source, 'visits', count(*)) as data
      from v where channel in ('social', 'email') group by channel, source having count(*) >= 10
     order by count(*) desc limit 2
  ),
  -- 5. pages lues par des visiteurs mais jamais par un robot d'IA
  unread as (
    select 'ai_unread' as kind, 50 as weight, jsonb_build_object('path', ps.path, 'visits', ps.visits) as data
      from page_stats ps
     where exists (select 1 from public.site_bot_hits where day between p_from and p_to and kind = 'ai')
       and not exists (select 1 from public.site_bot_hits h where h.day between p_from and p_to and h.kind = 'ai' and h.status <> 'unverified' and h.path = ps.path)
       and ps.visits >= 10 and ps.path !~* '(mentions|confidentialite|cookies|cgu|cgv)'
     order by ps.visits desc limit 2
  ),
  -- 6. connecteurs à brancher ou à reconnecter : sans eux, pas de mots-clés
  seo as (
    select 'connector' as kind, 5 as weight, jsonb_build_object('provider', p.provider, 'status', coalesce(s.status, 'missing')) as data
      from unnest(array['gsc', 'bing']) p(provider) left join public.seo_connections s on s.provider = p.provider
     where s.provider is null or s.status <> 'connected'
  ),
  everything as (
    select * from seo union all select * from kw union all select * from pages union all select * from moves
    union all select * from untagged union all select * from unread
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'data', data) order by weight), '[]'::jsonb) from everything;
$$;

revoke execute on function public.site_recommendations(date, date) from public, anon;
grant execute on function public.site_recommendations(date, date) to authenticated;
