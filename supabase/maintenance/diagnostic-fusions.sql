-- Diagnostic des fusions passées (LECTURE SEULE) — à exécuter dans le SQL Editor de Supabase.
-- Avant la correction de l'audit (C02), une fusion laissait sur la fiche absorbée (archivée, invisible) ses projets,
-- ses rendez-vous et parfois sa vente. Cette requête liste ce qui y est resté, fiche par fiche.
-- « fiche_finale » suit la chaîne des fusions (une fiche conservée peut avoir été fusionnée à son tour).
with recursive chain as (
  select id as absorbed_id, merged_into_id as final_id from public.companies where merged_into_id is not null
  union all
  select ch.absorbed_id, c.merged_into_id from chain ch join public.companies c on c.id = ch.final_id where c.merged_into_id is not null
),
roots as (
  select absorbed_id, (array_agg(final_id order by final_id))[1] as final_id from (
    select absorbed_id, final_id from chain ch where not exists (select 1 from public.companies c where c.id = ch.final_id and c.merged_into_id is not null)
  ) x group by absorbed_id
)
select a.name as fiche_absorbee, a.id as absorbee_id, f.name as fiche_finale, f.id as finale_id,
       (select count(*) from public.projects where company_id = a.id) as projets,
       (select count(*) from public.appt_bookings where company_id = a.id) as rendez_vous,
       (select count(*) from public.sales where company_id = a.id) as ventes,
       (select count(*) from public.sales where company_id = a.id and state in ('won', 'reopened')) as ventes_en_cours,
       (select count(*) from public.sales where company_id = f.id and state in ('won', 'reopened')) as ventes_en_cours_finale,
       (select count(*) from public.finance_missions where company_id = a.id) as revenus,
       (select count(*) from public.finance_invoices where company_id = a.id) as factures,
       (select count(*) from public.company_files where company_id = a.id) as fichiers,
       (select count(*) from public.people where company_id = a.id) as personnes
  from roots r join public.companies a on a.id = r.absorbed_id join public.companies f on f.id = r.final_id
 where exists (select 1 from public.projects where company_id = a.id)
    or exists (select 1 from public.appt_bookings where company_id = a.id)
    or exists (select 1 from public.sales where company_id = a.id)
    or exists (select 1 from public.finance_missions where company_id = a.id)
    or exists (select 1 from public.finance_invoices where company_id = a.id)
    or exists (select 1 from public.company_files where company_id = a.id)
    or exists (select 1 from public.people where company_id = a.id)
 order by a.name;
