-- Parcours d'un client, de l'appel à l'onboarding : l'état dont se déduit SA prochaine action principale
-- (fiche, carte du Pipeline, Appels, Agenda, Aujourd'hui). Une ligne par fiche concernée.
-- Lecture seule, aucune étape de pipeline n'y figure : l'état se lit dans les documents (appel, diagnostic,
-- proposition, devis signé, onboarding). Vue en droits de l'appelant : chaque table garde ses propres règles.

create or replace view public.company_journey with (security_invoker = true) as
  select c.id as company_id, c.name, c.deal_status,
         nullif(greatest(
           coalesce((select max(f.occurred_at) from public.fireflies_calls f where f.company_id = c.id and f.link_state = 'linked'), '-infinity'),
           coalesce((select max(b.ends_at) from public.appt_bookings b
                      where b.company_id = c.id and b.status = 'confirmed' and b.ends_at < now() and coalesce(b.outcome, 'done') = 'done'), '-infinity')
         ), '-infinity') as last_call_at,
         d.id as diagnostic_id, d.status as diagnostic_status, d.created_at as diagnostic_at,
         (select max(v.ready_at) from public.diagnostic_versions v where v.diagnostic_id = d.id and v.status = 'ready') as diagnostic_ready_at,
         (select max(v.validated_at) from public.diagnostic_versions v where v.diagnostic_id = d.id) as diagnostic_validated_at,
         g.id as proposal_id, g.created_at as proposal_at, gv.version as proposal_version, gv.slides_status as proposal_slides,
         gv.ready_at as proposal_ready_at, gv.validated_at as proposal_validated_at, gv.sent_at as proposal_sent_at,
         (select max(pv.signed_at) from public.proposal_versions pv join public.generator_versions x on x.id = pv.version_id where x.dossier_id = g.id) as proposal_signed_at,
         coalesce((select s.project_id from public.sales s where s.company_id = c.id and s.state in ('won', 'reopened') and s.project_id is not null order by s.cycle desc limit 1), o.project_id) as project_id,
         o.id as onboarding_id, o.created_at as onboarding_at, ov.version as onboarding_version, ov.slides_status as onboarding_slides,
         ov.ready_at as onboarding_ready_at, ov.validated_at as onboarding_validated_at
    from public.companies c
    left join lateral (select * from public.diagnostics x where x.company_id = c.id order by x.created_at desc limit 1) d on true
    left join lateral (select * from public.generator_dossiers x where x.company_id = c.id and x.kind = 'proposal' order by x.created_at desc limit 1) g on true
    left join lateral (select * from public.generator_versions x where x.dossier_id = g.id order by x.version desc limit 1) gv on true
    left join lateral (select * from public.generator_dossiers x where x.company_id = c.id and x.kind = 'onboarding' order by x.created_at desc limit 1) o on true
    left join lateral (select * from public.generator_versions x where x.dossier_id = o.id order by x.version desc limit 1) ov on true
   where c.merged_into_id is null and c.archived_at is null
     and (d.id is not null or g.id is not null
          or exists (select 1 from public.fireflies_calls f where f.company_id = c.id and f.link_state = 'linked')
          or exists (select 1 from public.appt_bookings b where b.company_id = c.id and b.status = 'confirmed' and b.ends_at < now() and coalesce(b.outcome, 'done') = 'done'));
revoke all on public.company_journey from public, anon, authenticated;
grant select on public.company_journey to authenticated;
