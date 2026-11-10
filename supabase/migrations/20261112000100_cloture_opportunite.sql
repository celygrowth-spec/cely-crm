-- Clôturer une opportunité en un clic (fiche et Kanban) : une seule logique, la même source de vérité.
--  * l'étape (stage_id) décrit la progression commerciale ; l'issue (deal_status) décrit la clôture ;
--  * Gagné : date de signature (aujourd'hui par défaut, modifiable, jamais dans le futur) et montant facultatif ;
--  * Perdu : motif facultatif ;
--  * Rouvrir : la fiche retrouve sa dernière étape (ou la première du pipeline s'il n'y en a plus) ;
--    un projet déjà lié est signalé dans la trace et conservé ;
--  * chaque changement laisse une trace datée dans l'activité de la fiche.
-- Additif : aucune donnée existante n'est modifiée.

drop function if exists public.set_deal_status(uuid, text, text);

create or replace function public.set_deal_status(
  p_company uuid,
  p_status text,
  p_lost_reason text default null,
  p_closed_on date default null,
  p_amount numeric default null)
returns jsonb
language plpgsql
as $$
declare
  c public.companies;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_closed timestamptz;
  v_stage public.stages;
  v_pipeline text;
  v_projects text;
  v_reason text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_text text;
begin
  perform public.assert_owner();
  if p_status not in ('open','won','lost') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.pipeline_id is null then
    raise exception 'La fiche doit être dans un pipeline pour être marquée gagnée ou perdue.' using errcode = '22023';
  end if;
  if c.deal_status = p_status then
    return jsonb_build_object('status', 'unchanged', 'deal_status', c.deal_status);
  end if;
  if p_status <> 'open' and c.deal_status <> 'open' then
    raise exception 'Opportunité déjà clôturée : rouvrez-la d''abord.' using errcode = '22023';
  end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Montant invalide' using errcode = '22023'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'Motif trop long (500 caractères au plus)' using errcode = '22023'; end if;

  select p.name into v_pipeline from public.pipelines p where p.id = c.pipeline_id;

  if p_status = 'won' then
    if p_closed_on is not null and p_closed_on > v_today then
      raise exception 'La date de signature ne peut pas être dans le futur.' using errcode = '22023';
    end if;
    -- aujourd'hui : l'heure réelle ; un autre jour : midi (heure de Paris), pour ne jamais changer de date
    v_closed := case when p_closed_on is null or p_closed_on = v_today then now()
                     else (p_closed_on + time '12:00') at time zone 'Europe/Paris' end;
    update public.companies
       set deal_status = 'won', deal_closed_at = v_closed, amount = coalesce(p_amount, amount)
     where id = c.id;
    v_text := 'Opportunité gagnée : signée le ' || to_char((v_closed at time zone 'Europe/Paris')::date, 'DD/MM/YYYY')
           || coalesce(' · ' || regexp_replace(replace(to_char(coalesce(p_amount, c.amount), 'FM999999999990.00'), '.', ','), ',00$', '') || ' €', '');

  elsif p_status = 'lost' then
    v_closed := now();
    update public.companies
       set deal_status = 'lost', deal_closed_at = v_closed, lost_reason = v_reason
     where id = c.id;
    v_text := 'Opportunité perdue' || coalesce(' : ' || v_reason, '');

  else
    -- rouvrir : retour à la dernière étape ; si elle n'existe plus, première étape du pipeline
    select * into v_stage from public.stages where id = c.stage_id;
    if not found then
      select * into v_stage from public.stages where pipeline_id = c.pipeline_id order by position limit 1;
    end if;
    select string_agg(pr.name, ', ' order by pr.created_at) into v_projects
      from public.projects pr where pr.company_id = c.id and pr.status <> 'archive';
    update public.companies
       set deal_status = 'open', deal_closed_at = null, stage_id = coalesce(v_stage.id, stage_id)
     where id = c.id;
    v_text := 'Opportunité rouverte : était ' || case c.deal_status when 'won' then 'gagnée' else 'perdue' end
           || coalesce(' · retour à l''étape ' || v_pipeline || ' › ' || v_stage.name, '')
           || coalesce(' · projet conservé : ' || v_projects, '');
  end if;

  perform public.log_event(c.id, 'deal_status', v_text,
    jsonb_build_object(
      'from', c.deal_status, 'to', p_status,
      'closed_at', v_closed,
      'amount', case when p_status = 'won' then coalesce(p_amount, c.amount) end,
      'lost_reason', case when p_status = 'lost' then v_reason end,
      'pipeline', v_pipeline,
      'stage', coalesce(v_stage.name, (select s.name from public.stages s where s.id = c.stage_id)),
      'projects', v_projects));

  return jsonb_build_object(
    'status', 'ok', 'deal_status', p_status, 'deal_closed_at', v_closed,
    'stage_id', coalesce(v_stage.id, c.stage_id), 'projects', v_projects);
end;
$$;

revoke execute on function public.set_deal_status(uuid, text, text, date, numeric) from public, anon;
grant execute on function public.set_deal_status(uuid, text, text, date, numeric) to authenticated;
