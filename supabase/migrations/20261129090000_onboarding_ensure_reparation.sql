-- Réparation : « Could not find the function public.onboarding_ensure(p_project) in the schema cache ».
-- La fonction est définie dans 20261114000100_projet_onboarding.sql, mais l'API de production ne la trouve pas
-- (fonction absente de la base, ou cache de l'API non rechargé après une migration appliquée à la main).
-- Cette migration est rejouable sans risque : elle redéfinit la fonction à l'identique, remet ses droits et
-- demande à l'API (PostgREST) de recharger son cache. Aucune donnée n'est modifiée.

create or replace function public.onboarding_ensure(p_project uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_sale uuid;
begin
  perform public.assert_owner();
  if exists (select 1 from public.project_onboarding where project_id = p_project) then return true; end if;
  select id into v_sale from public.sales where project_id = p_project;
  if v_sale is null then return false; end if;
  insert into public.project_onboarding (project_id, sale_id) values (p_project, v_sale) on conflict (project_id) do nothing;
  return true;
end; $$;

revoke all on function public.onboarding_ensure(uuid) from public, anon;
grant execute on function public.onboarding_ensure(uuid) to authenticated;

-- L'API relit la liste des fonctions (sans effet hors Supabase).
notify pgrst, 'reload schema';
