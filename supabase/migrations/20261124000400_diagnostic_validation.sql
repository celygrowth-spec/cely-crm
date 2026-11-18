-- Diagnostic : validation d'une version reçue. Ajout pur : le parcours existant (questions, versions, révisions)
-- ne change pas. « Diagnostic validé » sert de repère à la suite du parcours (email de présentation, proposition).
-- Réservée au propriétaire, dans l'application ; répétée, elle ne change rien.

alter table public.diagnostic_versions add column if not exists validated_at timestamptz;

create or replace function public.diagnostic_validate(p_id uuid, p_version integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz; v_status text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Validation du diagnostic');
  select validated_at, status into v_at, v_status from public.diagnostic_versions where diagnostic_id = p_id and version = p_version for update;
  if not found then raise exception 'Version introuvable' using errcode = 'P0002'; end if;
  if v_at is not null then return v_at; end if;
  if v_status <> 'ready' then raise exception 'Cette version n''est pas encore reçue' using errcode = '22023'; end if;
  update public.diagnostic_versions set validated_at = now() where diagnostic_id = p_id and version = p_version returning validated_at into v_at;
  return v_at;
end; $$;
revoke all on function public.diagnostic_validate(uuid, integer) from public, anon;
grant execute on function public.diagnostic_validate(uuid, integer) to authenticated;
