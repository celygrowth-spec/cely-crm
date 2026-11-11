-- Rattrapage des fusions passées (audit C02) — à exécuter dans le SQL Editor de Supabase, APRÈS la migration
-- 20261115000200_fusion_complete.sql et après avoir lu diagnostic-fusions.sql.
--
-- Ce que le rattrapage fait (cas sans ambiguïté) : il rattache à la fiche finale (fiche conservée, en suivant la chaîne
-- des fusions) les projets, rendez-vous, revenus, factures, fichiers et personnes restés sur une fiche absorbée, ainsi
-- que ses ventes TERMINÉES ou PERDUES (renumérotées). Une vente EN COURS sur la fiche absorbée n'est rattachée que si
-- la fiche finale n'a pas de vente en cours ET que son issue commerciale est compatible.
-- Ce qu'il ne fait jamais : réaffecter arbitrairement un cas ambigu. Ceux-ci sont listés par l'APERÇU (colonne
-- « a_resoudre ») et restent en place ; résolvez-les à la main (terminer ou perdre l'une des ventes), puis relancez.
--
-- 1. Exécutez l'APERÇU (lecture seule). 2. Exécutez le bloc RATTRAPAGE (tout ou rien). Rejouable sans effet de bord.

-- ============================================================ APERÇU (lecture seule)
with recursive chain as (
  select id as absorbed_id, merged_into_id as final_id from public.companies where merged_into_id is not null
  union all
  select ch.absorbed_id, c.merged_into_id from chain ch join public.companies c on c.id = ch.final_id where c.merged_into_id is not null
),
roots as (
  select absorbed_id, min(final_id::text)::uuid as final_id from chain ch
   where not exists (select 1 from public.companies c where c.id = ch.final_id and c.merged_into_id is not null) group by absorbed_id
)
select a.name as fiche_absorbee, f.name as fiche_finale,
       (select count(*) from public.projects where company_id = a.id) as projets,
       (select count(*) from public.appt_bookings where company_id = a.id) as rendez_vous,
       (select count(*) from public.sales where company_id = a.id and state not in ('won', 'reopened')) as ventes_passees,
       case
         when exists (select 1 from public.sales where company_id = a.id and state in ('won', 'reopened'))
          and (exists (select 1 from public.sales where company_id = f.id and state in ('won', 'reopened'))
               or f.deal_status <> (select case state when 'won' then 'won' else 'open' end from public.sales where company_id = a.id and state in ('won', 'reopened')))
         then 'vente en cours incompatible avec la fiche finale : à résoudre à la main'
         when exists (select 1 from public.sales where company_id = a.id and state in ('won', 'reopened')) then 'vente en cours rattachable'
         else '' end as a_resoudre
  from roots r join public.companies a on a.id = r.absorbed_id join public.companies f on f.id = r.final_id
 where exists (select 1 from public.projects where company_id = a.id) or exists (select 1 from public.appt_bookings where company_id = a.id)
    or exists (select 1 from public.sales where company_id = a.id) or exists (select 1 from public.finance_missions where company_id = a.id)
    or exists (select 1 from public.company_files where company_id = a.id) or exists (select 1 from public.people where company_id = a.id)
 order by a.name;

-- ============================================================ RATTRAPAGE (un seul bloc)
do $$
declare
  r record;
  v_offset int;
  v_active public.sales;
  v_moved int := 0;
  v_skipped int := 0;
begin
  for r in
    with recursive chain as (
      select id as absorbed_id, merged_into_id as final_id from public.companies where merged_into_id is not null
      union all
      select ch.absorbed_id, c.merged_into_id from chain ch join public.companies c on c.id = ch.final_id where c.merged_into_id is not null
    )
    select ch.absorbed_id, min(ch.final_id::text)::uuid as final_id from chain ch
     where not exists (select 1 from public.companies c where c.id = ch.final_id and c.merged_into_id is not null)
     group by ch.absorbed_id
  loop
    if not (exists (select 1 from public.projects where company_id = r.absorbed_id) or exists (select 1 from public.appt_bookings where company_id = r.absorbed_id)
            or exists (select 1 from public.finance_missions where company_id = r.absorbed_id) or exists (select 1 from public.finance_invoices where company_id = r.absorbed_id)
            or exists (select 1 from public.company_files where company_id = r.absorbed_id) or exists (select 1 from public.people where company_id = r.absorbed_id)
            or exists (select 1 from public.sales where company_id = r.absorbed_id)) then
      continue; -- rien à rattacher : déjà traité
    end if;
    -- vente en cours : rattachée seulement si la fiche finale n'en a pas et que son issue est compatible ;
    -- sinon RIEN n'est déplacé pour cette fiche (sa vente, son revenu et son projet restent ensemble)
    select * into v_active from public.sales where company_id = r.absorbed_id and state in ('won', 'reopened');
    if v_active.id is not null and (
         exists (select 1 from public.sales where company_id = r.final_id and state in ('won', 'reopened'))
         or (select deal_status from public.companies where id = r.final_id) <> (case v_active.state when 'won' then 'won' else 'open' end)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.projects set company_id = r.final_id where company_id = r.absorbed_id;
    update public.appt_bookings set company_id = r.final_id where company_id = r.absorbed_id;
    update public.finance_missions set company_id = r.final_id where company_id = r.absorbed_id;
    update public.finance_invoices set company_id = r.final_id where company_id = r.absorbed_id;
    update public.company_files set company_id = r.final_id where company_id = r.absorbed_id;
    update public.people set company_id = r.final_id, is_primary = false where company_id = r.absorbed_id;
    -- ventes passées : renumérotées après celles de la fiche finale
    select coalesce(max(cycle), 0) into v_offset from public.sales where company_id = r.final_id;
    update public.sales set company_id = r.final_id, cycle = cycle + v_offset
     where company_id = r.absorbed_id and state not in ('won', 'reopened');
    if v_active.id is not null then
      select coalesce(max(cycle), 0) into v_offset from public.sales where company_id = r.final_id;
      update public.sales set company_id = r.final_id, cycle = v_offset + 1 where id = v_active.id;
    end if;
    v_moved := v_moved + 1;
    perform public.log_event(r.final_id, 'merge', 'Rattrapage de fusion : éléments restés sur une fiche absorbée rattachés à cette fiche',
      jsonb_build_object('absorbed_company_id', r.absorbed_id));
  end loop;
  raise notice 'Fiches absorbées traitées : % ; cas à résoudre à la main : %.', v_moved, v_skipped;
end $$;
