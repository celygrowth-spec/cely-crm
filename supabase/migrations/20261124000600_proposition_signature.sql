-- Signature d'une proposition : deux chemins, un seul résultat, une seule fois.
--   * Make renvoie « devis signé » (make_return → make_private.apply_quote_return) ;
--   * « Marquer comme signée » dans l'application (proposal_mark_signed), pour une signature arrivée hors Make.
-- Les deux passent par make_private.sign_quote : la version signée est celle du devis signé, même si une version
-- plus récente existe (c'est elle qui fait foi pour l'onboarding). Les autres devis du dossier sont annulés : un
-- retour de Make qui les concernerait ensuite est journalisé et ignoré.
-- Le passage en client (fiche gagnée, vente, projet) reste fait par la logique existante, dans l'application.

create or replace function make_private.sign_quote(p_quote uuid, p_version uuid, p_via text, p_on date)
returns boolean language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_version uuid;
begin
  select * into q from public.quotes where id = p_quote for update;
  if q.id is null or q.status = 'cancelled' then return false; end if;
  -- déjà signé : rien de plus (retour rejoué, ou second chemin après le premier)
  if exists (select 1 from public.proposal_versions where quote_id = p_quote and signed_at is not null) then return false; end if;
  select pv.version_id into v_version
    from public.proposal_versions pv join public.generator_versions gv on gv.id = pv.version_id
   where pv.quote_id = p_quote and (p_version is null or pv.version_id = p_version)
   order by gv.version desc limit 1;
  if v_version is null then return false; end if;
  update public.proposal_versions set signed_at = now(), signed_via = p_via where version_id = v_version;
  update public.quotes set status = 'signed', signed_on = coalesce(p_on, signed_on, current_date), error = null where id = p_quote;
  update public.quotes set status = 'cancelled' where dossier_id = q.dossier_id and id <> p_quote and status <> 'signed';
  -- ce que le client a signé ne se modifie plus
  update public.generator_versions set validated_at = now() where id = v_version and validated_at is null and slides_status = 'ready';
  return true;
end; $$;
revoke execute on function make_private.sign_quote(uuid, uuid, text, date) from public, anon, authenticated;

-- Redéfinition complète : « signé » passe désormais par sign_quote.
create or replace function make_private.apply_quote_return(p_request_id uuid, p_event text, p_number text, p_url text, p_signed_on date, p_error text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_rank constant jsonb := '{"to_send":0,"to_retry":0,"error":0,"requested":1,"created":2,"sent":3,"signed":4}';
  v_target text := case p_event when 'quote.created' then 'created' when 'quote.sent' then 'sent' when 'quote.signed' then 'signed' else 'error' end;
  v_signed boolean;
begin
  select * into q from public.quotes where request_id = p_request_id for update;
  if q.id is null or q.status = 'cancelled' then return 'ignored'; end if;
  if v_target = 'error' then
    if q.status in ('created', 'sent', 'signed') then return 'unchanged'; end if;
    update public.quotes set status = 'error', error = coalesce(nullif(btrim(p_error), ''), 'Make a signalé une erreur.') where id = q.id;
    return 'applied';
  end if;
  update public.quotes set number = coalesce(nullif(btrim(p_number), ''), number), url = coalesce(p_url, url) where id = q.id;
  if v_target = 'signed' then
    v_signed := make_private.sign_quote(q.id, null, 'make', p_signed_on);
    return case when v_signed then 'applied' else 'unchanged' end;
  end if;
  update public.quotes
     set status = case when (v_rank ->> v_target)::int > (v_rank ->> status)::int then v_target else status end, error = null
   where id = q.id;
  return case when (v_rank ->> v_target)::int > (v_rank ->> q.status)::int then 'applied' else 'unchanged' end;
end; $$;
revoke execute on function make_private.apply_quote_return(uuid, text, text, text, date, text) from public, anon, authenticated;

-- « Marquer comme signée » : réservé au propriétaire, dans l'application, sur une version validée. Répété, ou après
-- le retour de Make pour le même devis, il ne change rien (already = true).
create or replace function public.proposal_mark_signed(p_version uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pv public.proposal_versions; q public.quotes; v_validated timestamptz; v_other integer;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Signature d''une proposition');
  select * into pv from public.proposal_versions where version_id = p_version;
  if pv.version_id is null then raise exception 'Version introuvable' using errcode = 'P0002'; end if;
  select * into q from public.quotes where id = pv.quote_id for update;
  if pv.signed_at is not null then return jsonb_build_object('already', true, 'company_id', q.company_id); end if;
  select validated_at into v_validated from public.generator_versions where id = p_version;
  if v_validated is null then raise exception 'Validez la version avant de la marquer comme signée' using errcode = '22023'; end if;
  select gv.version into v_other from public.proposal_versions x join public.quotes xq on xq.id = x.quote_id join public.generator_versions gv on gv.id = x.version_id
   where xq.dossier_id = q.dossier_id and x.signed_at is not null limit 1;
  if v_other is not null then raise exception 'La V% de cette proposition est déjà signée', v_other using errcode = '22023'; end if;
  perform make_private.sign_quote(q.id, p_version, 'manual', current_date);
  return jsonb_build_object('already', false, 'company_id', q.company_id);
end; $$;
revoke all on function public.proposal_mark_signed(uuid) from public, anon;
grant execute on function public.proposal_mark_signed(uuid) to authenticated;

-- Propositions signées : la version qui fait foi, et la dernière version du dossier (pour prévenir si elles diffèrent).
create or replace view public.proposal_signed with (security_invoker = true) as
  select q.company_id, q.dossier_id, pv.version_id, gv.version,
         (select max(x.version) from public.generator_versions x where x.dossier_id = q.dossier_id) as latest_version,
         q.id as quote_id, pv.signed_at, pv.signed_via, q.signed_on, q.payload
    from public.proposal_versions pv
    join public.quotes q on q.id = pv.quote_id
    join public.generator_versions gv on gv.id = pv.version_id
   where pv.signed_at is not null;
revoke all on public.proposal_signed from public, anon, authenticated;
grant select on public.proposal_signed to authenticated;
