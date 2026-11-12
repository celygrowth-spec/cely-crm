-- Corbeille, lot 2 : Finance (revenus, factures et avoirs, règlements).
--  * Un règlement part seul ; une facture part avec ses règlements et ses avoirs (et leurs remboursements) ;
--    un revenu part avec ses factures. Les totaux de Finance les ignorent aussitôt (vues sous RLS).
--  * Tout se supprime après confirmation, y compris une facture émise ou réglée. Son numéro reste réservé :
--    il n'est jamais réattribué (contrôle étendu aux factures à la corbeille) et la facture le retrouve à la
--    restauration (rien n'est réécrit).
--  * Un revenu lié à une vente : la vente reste, sans ce revenu.
-- Additif : politiques restrictives ajoutées ; finance_record_invoice et finance_update_invoice redéfinies
-- entièrement (seul changement : le contrôle du numéro voit aussi les factures à la corbeille).

-- ---------------------------------------------------------------------------
-- Invisibilité imposée par la base
-- ---------------------------------------------------------------------------
select trash_private.hide('finance_missions', array['id:finance_missions', 'company_id:companies']);
select trash_private.hide('finance_invoices', array['id:finance_invoices', 'company_id:companies', 'mission_id:finance_missions', 'credited_invoice_id:finance_invoices']);
select trash_private.hide('finance_payments', array['id:finance_payments', 'invoice_id:finance_invoices']);

-- ---------------------------------------------------------------------------
-- Outils
-- ---------------------------------------------------------------------------
create or replace function trash_private.eur(p numeric)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(to_char(coalesce(p, 0), 'FM999,999,990.00'), ',', ' '), '.', ',') || ' €';
$$;

create or replace function trash_private.fr_date(p date)
returns text language sql immutable set search_path = '' as $$ select to_char(p, 'DD/MM/YYYY'); $$;

-- Numéro de facture déjà pris pour ce client, factures à la corbeille comprises (droits d'administration : une
-- facture à la corbeille est invisible pour l'appelant). Ne renvoie qu'un booléen.
create or replace function public.finance_reference_reserved(p_company uuid, p_ref text, p_exclude uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_app_owner() and p_ref is not null and exists (
    select 1 from public.finance_invoices
     where company_id = p_company and kind = 'facture' and cancelled_at is null
       and lower(reference) = lower(btrim(p_ref)) and (p_exclude is null or id <> p_exclude));
$$;
revoke all on function public.finance_reference_reserved(uuid, text, uuid) from public, anon;
grant execute on function public.finance_reference_reserved(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Règlement
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_finance_payment(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', case when p.kind = 'remboursement' then 'Remboursement de ' else 'Règlement de ' end
             || trash_private.eur(p.amount) || ' du ' || trash_private.fr_date(p.paid_on),
    'context', case when i.kind = 'avoir' then 'Avoir' else 'Facture' end || coalesce(' ' || i.reference, ' du ' || trash_private.fr_date(i.issue_date))
               || ' · ' || c.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'finance_invoices', 'id', i.id)),
    'warnings', case when p.cancelled_at is null and p.kind = 'paiement'
                     then jsonb_build_array('Le reste à encaisser de la facture augmentera de ' || trash_private.eur(p.amount) || '.')
                     else '[]'::jsonb end)
    from public.finance_payments p
    join public.finance_invoices i on i.id = p.invoice_id
    join public.companies c on c.id = i.company_id
   where p.id = p_id;
$$;

create or replace function trash_private.collect_finance_payment(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'finance_payments', p.id from public.finance_payments p where p.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Facture (ou avoir) : ses règlements, ses avoirs et leurs remboursements
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_finance_invoice(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', case when o.kind = 'avoir' then 'Avoir' else 'Facture' end
             || coalesce(' ' || o.reference, ' du ' || trash_private.fr_date(o.issue_date))
             || ' · ' || trash_private.eur(o.amount_ttc) || ' TTC',
    'context', o.company_name || coalesce(' · ' || o.mission_label, ''),
    'parents', jsonb_build_array(jsonb_build_object('t', 'companies', 'id', o.company_id))
               || case when o.mission_id is not null then jsonb_build_array(jsonb_build_object('t', 'finance_missions', 'id', o.mission_id)) else '[]'::jsonb end
               || case when o.credited_invoice_id is not null then jsonb_build_array(jsonb_build_object('t', 'finance_invoices', 'id', o.credited_invoice_id)) else '[]'::jsonb end,
    'warnings', to_jsonb(array_remove(array[
      case when o.kind = 'facture' and o.status = 'payee' and o.paid_net > 0
           then 'Facture réglée : ' || trash_private.eur(o.paid_net) || ' encaissés sortent des totaux de Finance (ils y reviennent à la restauration).' end,
      case when o.kind = 'facture' and o.status <> 'payee' and o.paid_net > 0
           then 'Règlement partiel : ' || trash_private.eur(o.paid_net) || ' encaissés sur ' || trash_private.eur(o.amount_ttc) || ' ; ils partent avec la facture.' end,
      case when o.kind = 'facture' and o.balance > 0 and o.cancelled_at is null
           then trash_private.eur(o.balance) || ' sortent du reste à encaisser.' end,
      case when o.reference is not null
           then 'Son numéro « ' || o.reference || ' » reste réservé : il ne sera pas réattribué et la facture le retrouvera si vous la restaurez.' end
    ], null)))
    from public.finance_invoice_overview o
   where o.id = p_id;
$$;

create or replace function trash_private.collect_finance_invoice(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  with inv as (
    select i.id from public.finance_invoices i where i.id = p_id
    union
    select a.id from public.finance_invoices a where a.credited_invoice_id = p_id
  )
  select 'finance_invoices', id from inv
  union all
  select 'finance_payments', p.id from public.finance_payments p where p.invoice_id in (select id from inv);
$$;

-- ---------------------------------------------------------------------------
-- Revenu : ses factures (et ce qui part avec elles)
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_finance_mission(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', m.label,
    'context', c.name || case when m.amount is not null then ' · ' || trash_private.eur(m.amount) || ' HT'
                              || case when m.kind = 'recurrent' then ' par échéance' else '' end else '' end,
    'parents', jsonb_build_array(jsonb_build_object('t', 'companies', 'id', m.company_id)),
    'warnings', to_jsonb(array_remove(array[
      case when exists (select 1 from public.sales s where s.mission_id = m.id)
           then 'Ce revenu est lié à la vente de ' || c.name || ' : la vente reste, sans ce revenu (il revient si vous le restaurez).' end,
      case when exists (select 1 from public.finance_invoices i where i.mission_id = m.id and i.kind = 'facture')
           then 'Ses factures partent avec lui ; leurs numéros restent réservés.' end
    ], null)))
    from public.finance_missions m join public.companies c on c.id = m.company_id
   where m.id = p_id;
$$;

create or replace function trash_private.collect_finance_mission(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'finance_missions', m.id from public.finance_missions m where m.id = p_id
  union all
  select c.row_table, c.row_id from public.finance_invoices i
   cross join lateral trash_private.collect_finance_invoice(i.id) c
   where i.mission_id = p_id and i.kind = 'facture';
$$;

revoke all on function trash_private.eur(numeric), trash_private.fr_date(date),
  trash_private.describe_finance_payment(uuid), trash_private.collect_finance_payment(uuid),
  trash_private.describe_finance_invoice(uuid), trash_private.collect_finance_invoice(uuid),
  trash_private.describe_finance_mission(uuid), trash_private.collect_finance_mission(uuid) from public, anon;
grant execute on function trash_private.eur(numeric), trash_private.fr_date(date),
  trash_private.describe_finance_payment(uuid), trash_private.collect_finance_payment(uuid),
  trash_private.describe_finance_invoice(uuid), trash_private.collect_finance_invoice(uuid),
  trash_private.describe_finance_mission(uuid), trash_private.collect_finance_mission(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Numéro de facture réservé (redéfinitions complètes)
-- ---------------------------------------------------------------------------
create or replace function public.finance_update_invoice(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_inv public.finance_invoices; v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_paid numeric(12,2); v_mission uuid;
begin
  perform public.assert_owner();
  select * into v_inv from public.finance_invoices where id = p_id for update;
  if v_inv.id is null then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  v_ht := case when p_data ? 'amount_ht' then public.finance_num(p_data, 'amount_ht') else v_inv.amount_ht end;
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant HT doit être positif' using errcode = '22023'; end if;
  v_vat := case when p_data ? 'vat_amount' then public.finance_num(p_data, 'vat_amount') else v_inv.vat_amount end;
  v_ttc := case when p_data ? 'amount_ttc' then public.finance_num(p_data, 'amount_ttc')
                when p_data ? 'amount_ht' or p_data ? 'vat_amount' then v_ht + coalesce(v_vat, 0) else v_inv.amount_ttc end;
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  select paid_net into v_paid from public.finance_invoice_overview where id = p_id;
  if v_ttc < coalesce(v_paid, 0) then
    raise exception 'Le montant TTC serait inférieur aux paiements déjà reçus' using errcode = '22023';
  end if;
  v_mission := case when p_data ? 'mission_id' then nullif(p_data ->> 'mission_id', '')::uuid else v_inv.mission_id end;
  if v_mission is not null and not exists (select 1 from public.finance_missions where id = v_mission and company_id = v_inv.company_id) then
    raise exception 'Ce revenu appartient à un autre client.' using errcode = '22023';
  end if;
  if v_inv.kind = 'facture' and p_data ? 'reference' and public.finance_txt(p_data, 'reference') is not null
     and lower(public.finance_txt(p_data, 'reference')) is distinct from lower(v_inv.reference)
     and public.finance_reference_reserved(v_inv.company_id, public.finance_txt(p_data, 'reference'), p_id) then
    raise exception 'La facture « % » est déjà enregistrée pour ce client.', public.finance_txt(p_data, 'reference') using errcode = '23505';
  end if;
  update public.finance_invoices set
    reference = case when p_data ? 'reference' then public.finance_txt(p_data, 'reference') else reference end,
    issue_date = coalesce(case when p_data ? 'issue_date' then public.finance_date(p_data, 'issue_date') end, issue_date),
    due_date = case when p_data ? 'due_date' then public.finance_date(p_data, 'due_date') else due_date end,
    amount_ht = v_ht,
    vat_rate = case when p_data ? 'vat_rate' then nullif(p_data ->> 'vat_rate', '')::numeric(5,2) else vat_rate end,
    vat_amount = v_vat, amount_ttc = v_ttc,
    note = case when p_data ? 'note' then public.finance_txt(p_data, 'note') else note end,
    mission_id = v_mission,
    forecast_due_date = case when p_data ? 'forecast_due_date' then public.finance_date(p_data, 'forecast_due_date')
                             when v_mission is distinct from v_inv.mission_id then null else forecast_due_date end
  where id = p_id;
  return jsonb_build_object('id', p_id);
end;
$$;

create or replace function public.finance_record_invoice(p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_id uuid; v_company uuid; v_mission uuid; v_m public.finance_missions;
  v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_cover date; v_ref text; v_billed numeric(12,2);
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_company := nullif(p_data ->> 'company_id', '')::uuid;
  v_mission := nullif(p_data ->> 'mission_id', '')::uuid;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  if v_mission is not null then
    select * into v_m from public.finance_missions where id = v_mission for update;
    if v_m.id is null or v_m.company_id <> v_company then
      raise exception 'Ce revenu appartient à un autre client.' using errcode = '22023';
    end if;
  end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant HT doit être positif' using errcode = '22023'; end if;
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  v_ref := public.finance_txt(p_data, 'reference');
  -- numéro réservé : une facture à la corbeille le garde (jamais réattribué, retrouvé à la restauration)
  if v_ref is not null and public.finance_reference_reserved(v_company, v_ref, null) then
    raise exception 'La facture « % » est déjà enregistrée pour ce client.', v_ref using errcode = '23505';
  end if;
  if v_m.id is not null and v_m.kind = 'ponctuel' and v_m.amount is not null then
    select coalesce(sum(amount_ht), 0) into v_billed from public.finance_invoices
     where mission_id = v_m.id and kind = 'facture' and cancelled_at is null;
    if v_billed + v_ht > v_m.amount then
      raise exception 'Le total facturé (% €) dépasserait le montant du revenu (% €) : modifiez d''abord le revenu.',
        v_billed + v_ht, v_m.amount using errcode = '22023';
    end if;
  end if;
  v_cover := public.finance_date(p_data, 'forecast_due_date');

  insert into public.finance_invoices (company_id, mission_id, reference, issue_date, due_date, amount_ht, vat_rate, vat_amount,
                                       amount_ttc, forecast_due_date, note)
  values (v_company, v_mission, v_ref, public.finance_date(p_data, 'issue_date'),
          public.finance_date(p_data, 'due_date'), v_ht, nullif(p_data ->> 'vat_rate', '')::numeric(5,2), v_vat, v_ttc,
          v_cover, public.finance_txt(p_data, 'note'))
  returning id, forecast_due_date into v_id, v_cover;

  if v_cover is not null and v_m.id is not null and v_m.kind = 'recurrent' and v_m.next_due_date = v_cover then
    update public.finance_missions set next_due_date = public.finance_add_frequency(v_cover, v_m.frequency) where id = v_m.id;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_record_invoice', jsonb_build_object('id', v_id));
end;
$$;
