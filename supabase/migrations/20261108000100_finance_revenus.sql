-- Finance — revenus unifiés (ponctuels et mensuels). Migration additive : AUCUNE table modifiée,
-- seulement des fonctions. Un revenu est une mission (finance_missions) ; le réel reste porté par les
-- factures et les paiements. Chaque fonction agit en une seule transaction (rien de partiel).

-- Échéance n° k d'une récurrence : date de départ + k × fréquence. Postgres ramène un jour absent au
-- dernier jour du mois, et le jour habituel revient le mois suivant (calcul toujours depuis le départ).
create or replace function public.finance_due_date(p_start date, p_frequency text, p_k int)
returns date
language sql
immutable
as $$ select public.finance_add_frequency(p_start, coalesce(p_frequency, 'mensuel'), p_k); $$;

-- Ajouter un revenu.
-- p_data : {company_id, label, kind: 'ponctuel'|'mensuel', amount (HT), date (encaissement prévu ou
--           première échéance), end_date?, note?, received?: {paid_on, amount?, vat_rate?}}
-- « received » (ponctuel uniquement) : la facture et le règlement sont créés et rattachés au revenu.
create or replace function public.finance_add_revenue(p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_id uuid; v_inv uuid; v_company uuid; v_kind text; v_amount numeric(12,2); v_date date; v_end date;
  v_paid_on date; v_paid numeric(12,2); v_rate numeric(5,2); v_vat numeric(12,2); v_ttc numeric(12,2);
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_company := nullif(p_data ->> 'company_id', '')::uuid;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  v_kind := public.finance_txt(p_data, 'kind');
  if v_kind not in ('ponctuel', 'mensuel') then raise exception 'Type de revenu invalide' using errcode = '22023'; end if;
  v_amount := public.finance_num(p_data, 'amount');
  if v_amount is null or v_amount <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  v_date := public.finance_date(p_data, 'date');
  if v_date is null then raise exception 'La date est obligatoire' using errcode = '22023'; end if;
  v_end := case when v_kind = 'mensuel' then public.finance_date(p_data, 'end_date') end;
  if v_end is not null and v_end < v_date then raise exception 'La date de fin précède la première échéance' using errcode = '22023'; end if;

  insert into public.finance_missions (company_id, label, status, kind, start_date, end_date, amount, frequency, next_due_date, note)
  values (v_company, btrim(p_data ->> 'label'), 'actif', case when v_kind = 'mensuel' then 'recurrent' else 'ponctuel' end,
          v_date, v_end, v_amount, case when v_kind = 'mensuel' then 'mensuel' end, v_date, public.finance_txt(p_data, 'note'))
  returning id into v_id;

  if v_kind = 'ponctuel' and jsonb_typeof(p_data -> 'received') = 'object' then
    v_paid_on := public.finance_date(p_data -> 'received', 'paid_on');
    if v_paid_on is null then raise exception 'Indiquez la date de réception du paiement' using errcode = '22023'; end if;
    v_rate := nullif(p_data -> 'received' ->> 'vat_rate', '')::numeric(5,2);
    v_vat := case when v_rate is null then null else round(v_amount * v_rate / 100, 2) end;
    v_ttc := v_amount + coalesce(v_vat, 0);
    v_paid := coalesce(public.finance_num(p_data -> 'received', 'amount'), v_ttc);
    if v_paid <= 0 or v_paid > v_ttc then raise exception 'Le montant reçu doit être compris entre 0 et %', v_ttc using errcode = '22023'; end if;
    insert into public.finance_invoices (company_id, mission_id, issue_date, due_date, amount_ht, vat_rate, vat_amount, amount_ttc, forecast_due_date)
    values (v_company, v_id, least(v_date, v_paid_on), v_date, v_amount, v_rate, v_vat, v_ttc, v_date)
    returning id into v_inv;
    insert into public.finance_payments (invoice_id, kind, paid_on, amount) values (v_inv, 'paiement', v_paid_on, v_paid);
  end if;
  return public.idem_put(p_idempotency_key, 'finance_add_revenue', jsonb_build_object('id', v_id, 'invoice_id', v_inv));
end;
$$;

-- Encaisser (ou facturer) UNE échéance d'un revenu : crée la facture rattachée à l'échéance puis, si
-- une date de réception est donnée, le règlement (partiel accepté). Refuse une échéance déjà couverte :
-- le paiement s'enregistre alors sur la facture existante (jamais de double comptage).
-- p_data : {due_date, amount (HT dû), vat_rate?, reference?, paid_on?, paid_amount?, note?}
create or replace function public.finance_settle_due(p_mission uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_m public.finance_missions; v_due date; v_ht numeric(12,2); v_rate numeric(5,2); v_vat numeric(12,2);
  v_ttc numeric(12,2); v_paid_on date; v_paid numeric(12,2); v_inv uuid; v_ok boolean := false; k int;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_m from public.finance_missions where id = p_mission for update;
  if v_m.id is null then raise exception 'Revenu introuvable' using errcode = 'P0002'; end if;
  v_due := public.finance_date(p_data, 'due_date');
  if v_due is null then raise exception 'Échéance manquante' using errcode = '22023'; end if;
  -- l'échéance doit appartenir au revenu
  if v_m.kind = 'ponctuel' then
    v_ok := v_due = coalesce(v_m.next_due_date, v_m.start_date);
  else
    for k in 0..600 loop
      exit when public.finance_due_date(coalesce(v_m.start_date, v_m.next_due_date), v_m.frequency, k) > v_due;
      if public.finance_due_date(coalesce(v_m.start_date, v_m.next_due_date), v_m.frequency, k) = v_due then v_ok := true; exit; end if;
    end loop;
    if v_m.end_date is not null and v_due > v_m.end_date then v_ok := false; end if;
  end if;
  if not v_ok then raise exception 'Cette date n''est pas une échéance de ce revenu' using errcode = '22023'; end if;
  if exists (select 1 from public.finance_invoices where mission_id = v_m.id and forecast_due_date = v_due and kind = 'facture' and cancelled_at is null) then
    raise exception 'Cette échéance a déjà une facture : enregistrez le paiement sur cette facture' using errcode = '22023';
  end if;
  v_ht := public.finance_num(p_data, 'amount');
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  v_rate := nullif(p_data ->> 'vat_rate', '')::numeric(5,2);
  v_vat := case when v_rate is null then null else round(v_ht * v_rate / 100, 2) end;
  v_ttc := v_ht + coalesce(v_vat, 0);
  v_paid_on := public.finance_date(p_data, 'paid_on');
  insert into public.finance_invoices (company_id, mission_id, reference, issue_date, due_date, amount_ht, vat_rate, vat_amount, amount_ttc, forecast_due_date, note)
  values (v_m.company_id, v_m.id, public.finance_txt(p_data, 'reference'), least(v_due, coalesce(v_paid_on, v_due)), v_due,
          v_ht, v_rate, v_vat, v_ttc, v_due, public.finance_txt(p_data, 'note'))
  returning id into v_inv;
  if v_paid_on is not null then
    v_paid := coalesce(public.finance_num(p_data, 'paid_amount'), v_ttc);
    if v_paid <= 0 or v_paid > v_ttc then raise exception 'Le montant reçu doit être compris entre 0 et %', v_ttc using errcode = '22023'; end if;
    insert into public.finance_payments (invoice_id, kind, paid_on, amount) values (v_inv, 'paiement', v_paid_on, v_paid);
  end if;
  return public.idem_put(p_idempotency_key, 'finance_settle_due', jsonb_build_object('id', v_inv));
end;
$$;

-- Modifier un revenu pour la suite : libellé, montant, première échéance (si rien n'est encore
-- facturé), date de fin. Les mois déjà facturés gardent leur montant (porté par leurs factures).
create or replace function public.finance_update_revenue(p_mission uuid, p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_m public.finance_missions; v_amount numeric(12,2); v_date date; v_end date;
begin
  perform public.assert_owner();
  select * into v_m from public.finance_missions where id = p_mission for update;
  if v_m.id is null then raise exception 'Revenu introuvable' using errcode = 'P0002'; end if;
  v_amount := public.finance_num(p_data, 'amount');
  if v_amount is null or v_amount <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  v_date := coalesce(public.finance_date(p_data, 'date'), v_m.start_date);
  if v_date is distinct from v_m.start_date and v_m.kind = 'recurrent'
     and exists (select 1 from public.finance_invoices where mission_id = v_m.id and cancelled_at is null) then
    raise exception 'Des échéances sont déjà facturées : la première échéance ne peut plus changer. Arrêtez ce revenu et créez-en un nouveau.' using errcode = '22023';
  end if;
  v_end := case when v_m.kind = 'recurrent' then public.finance_date(p_data, 'end_date') end;
  if v_end is not null and v_end < v_date then raise exception 'La date de fin précède la première échéance' using errcode = '22023'; end if;
  update public.finance_missions set
    label = coalesce(nullif(btrim(p_data ->> 'label'), ''), label),
    amount = v_amount,
    start_date = v_date,
    next_due_date = case when kind = 'ponctuel' then v_date else coalesce(next_due_date, v_date) end,
    end_date = v_end,
    -- une récurrence relancée (fin retirée ou repoussée) redevient active
    status = case when status = 'termine' and (v_end is null or v_end >= public.today_paris()) then 'actif' else status end,
    note = case when p_data ? 'note' then public.finance_txt(p_data, 'note') else note end
  where id = v_m.id;
  return jsonb_build_object('id', v_m.id);
end;
$$;

-- Arrêter un revenu mensuel : plus aucune échéance après p_end (historique conservé).
create or replace function public.finance_stop_revenue(p_mission uuid, p_end date)
returns jsonb
language plpgsql
as $$
declare v_m public.finance_missions;
begin
  perform public.assert_owner();
  select * into v_m from public.finance_missions where id = p_mission for update;
  if v_m.id is null or v_m.kind <> 'recurrent' then raise exception 'Revenu mensuel introuvable' using errcode = 'P0002'; end if;
  if p_end is null then raise exception 'Indiquez la date de fin' using errcode = '22023'; end if;
  if v_m.start_date is not null and p_end < v_m.start_date then raise exception 'La date de fin précède la première échéance' using errcode = '22023'; end if;
  update public.finance_missions set end_date = p_end, status = case when p_end < public.today_paris() then 'termine' else status end where id = p_mission;
  return jsonb_build_object('id', p_mission);
end;
$$;

revoke execute on function public.finance_due_date(date, text, int), public.finance_add_revenue(jsonb, text),
  public.finance_settle_due(uuid, jsonb, text), public.finance_update_revenue(uuid, jsonb), public.finance_stop_revenue(uuid, date)
  from public, anon;
grant execute on function public.finance_due_date(date, text, int), public.finance_add_revenue(jsonb, text),
  public.finance_settle_due(uuid, jsonb, text), public.finance_update_revenue(uuid, jsonb), public.finance_stop_revenue(uuid, date)
  to authenticated;
