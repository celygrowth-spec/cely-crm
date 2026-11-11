-- Audit, lot 3 — Finance cohérente (C04, C05, Q06, Q07, K14 calculs).
-- Migration additive : une colonne (companies.amount_recurring), des fonctions, des déclencheurs et deux vues
-- reconstruites. Aucune donnée existante n'est modifiée à l'installation.

-- ===========================================================================
-- C04 — cohérence client ↔ revenu ↔ facture ↔ vente, contrôlée en base pour TOUS les chemins
-- (formulaires, Claude, fusion). Vérifiée en fin de transaction : une fusion qui déplace revenus et
-- factures ensemble reste possible ; un état incohérent à la validation est refusé.
-- ===========================================================================
create or replace function public.tg_finance_invoice_consistency()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.finance_invoices where id = new.id) then return null; end if;
  if new.mission_id is not null and exists (
       select 1 from public.finance_invoices i join public.finance_missions m on m.id = i.mission_id
        where i.id = new.id and m.company_id <> i.company_id) then
    raise exception 'Cette facture vise le revenu d''un autre client.' using errcode = '22023';
  end if;
  if new.credited_invoice_id is not null and exists (
       select 1 from public.finance_invoices a join public.finance_invoices f on f.id = a.credited_invoice_id
        where a.id = new.id and f.company_id <> a.company_id) then
    raise exception 'Un avoir appartient au même client que sa facture.' using errcode = '22023';
  end if;
  return null;
end;
$$;
drop trigger if exists finance_invoice_consistency on public.finance_invoices;
create constraint trigger finance_invoice_consistency
  after insert or update of company_id, mission_id, credited_invoice_id on public.finance_invoices
  deferrable initially deferred for each row execute function public.tg_finance_invoice_consistency();

create or replace function public.tg_finance_mission_consistency()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.finance_missions m join public.sales s on s.mission_id = m.id
              where m.id = new.id and s.company_id <> m.company_id) then
    raise exception 'Ce revenu est lié à une vente d''un autre client : il ne change pas de client.' using errcode = '22023';
  end if;
  if exists (select 1 from public.finance_missions m join public.finance_invoices i on i.mission_id = m.id
              where m.id = new.id and i.company_id <> m.company_id) then
    raise exception 'Des factures de ce revenu appartiennent à un autre client.' using errcode = '22023';
  end if;
  return null;
end;
$$;
drop trigger if exists finance_mission_consistency on public.finance_missions;
create constraint trigger finance_mission_consistency
  after update of company_id on public.finance_missions
  deferrable initially deferred for each row execute function public.tg_finance_mission_consistency();

-- Une vente ne pointe que vers un revenu de son client (contrôle immédiat, message clair).
create or replace function public.tg_sales_mission_company()
returns trigger
language plpgsql
as $$
begin
  if new.mission_id is not null and exists (select 1 from public.finance_missions m where m.id = new.mission_id and m.company_id <> new.company_id) then
    raise exception 'Ce revenu appartient à un autre client.' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists sales_mission_company on public.sales;
create constraint trigger sales_mission_company
  after insert or update of mission_id, company_id on public.sales
  deferrable initially deferred for each row execute function public.tg_sales_mission_company();

-- ---------------------------------------------------------------------------
-- Échéances : dates d'un revenu, facture qui couvre une échéance, échéance la plus proche non couverte.
-- Même règle que src/lib/finance/revenues.ts (coveringInvoice) : rattachement explicite, sinon, pour les
-- anciennes factures mensuelles sans rattachement, facture émise le même mois.
-- ---------------------------------------------------------------------------
create or replace function public.finance_due_covered(p_mission uuid, p_due date, p_except uuid default null)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.finance_invoices i join public.finance_missions m on m.id = i.mission_id
     where i.mission_id = p_mission and i.kind = 'facture' and i.cancelled_at is null and i.id is distinct from p_except
       and (i.forecast_due_date = p_due
            or (i.forecast_due_date is null and m.kind = 'recurrent' and coalesce(m.frequency, 'mensuel') = 'mensuel'
                and date_trunc('month', i.issue_date) = date_trunc('month', p_due))));
$$;

-- Échéance d'un revenu récurrent la plus proche d'une date, non encore couverte (null si aucune).
create or replace function public.finance_nearest_open_due(p_mission uuid, p_near date, p_except uuid default null)
returns date
language plpgsql
stable
as $$
declare m public.finance_missions; d date; best date; k int;
begin
  select * into m from public.finance_missions where id = p_mission;
  if m.id is null or m.kind <> 'recurrent' or coalesce(m.start_date, m.next_due_date) is null then return null; end if;
  for k in 0..600 loop
    d := public.finance_due_date(coalesce(m.start_date, m.next_due_date), m.frequency, k);
    exit when (m.end_date is not null and d > m.end_date) or d > p_near + 400;
    if not public.finance_due_covered(p_mission, d, p_except)
       and (best is null or abs(d - p_near) < abs(best - p_near)) then
      best := d;
    end if;
  end loop;
  return best;
end;
$$;

-- Q06 / C04 : toute facture rattachée à un revenu couvre une échéance précise ; une échéance mensuelle
-- n'est jamais couverte deux fois (sinon la prévision serait comptée en double ou disparaîtrait à tort).
create or replace function public.tg_finance_invoice_cover()
returns trigger
language plpgsql
as $$
declare m public.finance_missions;
begin
  if new.kind <> 'facture' then return new; end if;
  if new.mission_id is null then new.forecast_due_date := null; return new; end if;
  if tg_op = 'UPDATE' and new.mission_id is distinct from old.mission_id and new.forecast_due_date is not distinct from old.forecast_due_date then
    new.forecast_due_date := null;   -- autre revenu : l'ancienne échéance ne vaut plus
  end if;
  select * into m from public.finance_missions where id = new.mission_id;
  if new.forecast_due_date is null then
    new.forecast_due_date := case when m.kind = 'ponctuel' then coalesce(m.next_due_date, m.start_date)
                                  else public.finance_nearest_open_due(m.id, new.issue_date, new.id) end;
  elsif m.kind = 'recurrent' and new.cancelled_at is null and public.finance_due_covered(m.id, new.forecast_due_date, new.id) then
    raise exception 'L''échéance du % est déjà facturée : enregistrez le paiement sur cette facture.', to_char(new.forecast_due_date, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists finance_invoice_cover on public.finance_invoices;
create trigger finance_invoice_cover
  before insert or update of mission_id, forecast_due_date, cancelled_at on public.finance_invoices
  for each row execute function public.tg_finance_invoice_cover();

-- ---------------------------------------------------------------------------
-- Factures : modification partielle (un champ absent reste inchangé ; mission_id: null = retirer le lien),
-- jamais vers le revenu d'un autre client.
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

-- Facture enregistrée à la main : même contrôle client, et pour un ponctuel le total facturé ne dépasse pas
-- le montant prévu (acompte + solde = montant ; au-delà, modifiez d'abord le revenu). Référence unique par client.
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
  if v_ref is not null and exists (select 1 from public.finance_invoices where company_id = v_company and kind = 'facture'
                                    and cancelled_at is null and lower(reference) = lower(v_ref)) then
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

-- ---------------------------------------------------------------------------
-- Revenus (anciennes « missions ») : modification partielle ; un revenu lié à une vente, ou déjà facturé,
-- ne change pas de client.
-- ---------------------------------------------------------------------------
create or replace function public.finance_save_mission(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid; v_company uuid; m public.finance_missions;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_id is not null then
    select * into m from public.finance_missions where id = p_id for update;
    if m.id is null then raise exception 'Revenu introuvable' using errcode = 'P0002'; end if;
  end if;
  v_company := case when p_data ? 'company_id' then nullif(p_data ->> 'company_id', '')::uuid else m.company_id end;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  if p_id is null then
    insert into public.finance_missions (company_id, label, status, kind, start_date, end_date, amount, frequency, next_due_date, note)
    values (v_company, btrim(p_data ->> 'label'), coalesce(public.finance_txt(p_data, 'status'), 'actif'),
            coalesce(public.finance_txt(p_data, 'kind'), 'ponctuel'), public.finance_date(p_data, 'start_date'),
            public.finance_date(p_data, 'end_date'), public.finance_num(p_data, 'amount'),
            public.finance_txt(p_data, 'frequency'), coalesce(public.finance_date(p_data, 'next_due_date'), public.finance_date(p_data, 'start_date')),
            public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    if v_company <> m.company_id then
      if exists (select 1 from public.sales where mission_id = m.id) then
        raise exception 'Ce revenu est lié à une vente : il ne change pas de client. Fusionnez les fiches, ou créez un revenu pour l''autre client.' using errcode = '22023';
      end if;
      if exists (select 1 from public.finance_invoices where mission_id = m.id and cancelled_at is null) then
        raise exception 'Ce revenu a déjà des factures : il ne change pas de client.' using errcode = '22023';
      end if;
    end if;
    update public.finance_missions set
      company_id = v_company,
      label = coalesce(nullif(btrim(p_data ->> 'label'), ''), label),
      status = coalesce(public.finance_txt(p_data, 'status'), status),
      kind = coalesce(public.finance_txt(p_data, 'kind'), kind),
      start_date = case when p_data ? 'start_date' then public.finance_date(p_data, 'start_date') else start_date end,
      end_date = case when p_data ? 'end_date' then public.finance_date(p_data, 'end_date') else end_date end,
      amount = case when p_data ? 'amount' then public.finance_num(p_data, 'amount') else amount end,
      frequency = case when p_data ? 'frequency' then public.finance_txt(p_data, 'frequency') else frequency end,
      next_due_date = case when p_data ? 'next_due_date' then public.finance_date(p_data, 'next_due_date') else next_due_date end,
      note = case when p_data ? 'note' then public.finance_txt(p_data, 'note') else note end
    where id = m.id returning id into v_id;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_mission', jsonb_build_object('id', v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Q06 — « Facturer le solde » : un ponctuel accepte plusieurs factures (acompte puis solde) tant que le total
-- facturé ne dépasse pas le montant prévu. Un mensuel : une facture par échéance.
-- ---------------------------------------------------------------------------
create or replace function public.finance_settle_due(p_mission uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_m public.finance_missions; v_due date; v_ht numeric(12,2); v_rate numeric(5,2); v_vat numeric(12,2);
  v_ttc numeric(12,2); v_paid_on date; v_paid numeric(12,2); v_inv uuid; v_ok boolean := false; k int; v_billed numeric(12,2);
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_m from public.finance_missions where id = p_mission for update;
  if v_m.id is null then raise exception 'Revenu introuvable' using errcode = 'P0002'; end if;
  v_due := public.finance_date(p_data, 'due_date');
  if v_due is null then raise exception 'Échéance manquante' using errcode = '22023'; end if;
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
  v_ht := public.finance_num(p_data, 'amount');
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  if v_m.kind = 'ponctuel' then
    select coalesce(sum(amount_ht), 0) into v_billed from public.finance_invoices
     where mission_id = v_m.id and kind = 'facture' and cancelled_at is null;
    if v_m.amount is not null and v_billed + v_ht > v_m.amount then
      raise exception 'Il reste % € à facturer sur ce revenu (montant prévu % €).', greatest(v_m.amount - v_billed, 0), v_m.amount using errcode = '22023';
    end if;
  elsif public.finance_due_covered(v_m.id, v_due) then
    raise exception 'Cette échéance a déjà une facture : enregistrez le paiement sur cette facture' using errcode = '22023';
  end if;
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

-- ---------------------------------------------------------------------------
-- C05 (c) — annuler un paiement déjà remboursé donnerait un encaissé négatif : refusé.
-- ---------------------------------------------------------------------------
create or replace function public.finance_cancel_payment(p_id uuid)
returns jsonb
language plpgsql
as $$
declare p public.finance_payments; v_paid numeric(12,2); v_refunded numeric(12,2);
begin
  perform public.assert_owner();
  select * into p from public.finance_payments where id = p_id;
  if p.id is null then raise exception 'Paiement introuvable' using errcode = 'P0002'; end if;
  perform 1 from public.finance_invoices where id = p.invoice_id for update;
  if p.cancelled_at is null and p.kind = 'paiement' then
    select coalesce(sum(amount) filter (where kind = 'paiement'), 0), coalesce(sum(amount) filter (where kind = 'remboursement'), 0)
      into v_paid, v_refunded
      from public.finance_payments where invoice_id = p.invoice_id and cancelled_at is null and id <> p.id;
    if v_refunded > v_paid then
      raise exception 'Ce paiement a été remboursé : annulez d''abord le remboursement.' using errcode = '22023';
    end if;
  end if;
  update public.finance_payments set cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  return jsonb_build_object('id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- C05 (d) — un avoir réduit ce que le client doit, pas le montant prévu du revenu. S'il change l'engagement,
-- la décision est explicite : p_data.reduce_revenue = true réduit aussi le montant prévu (revenu ponctuel).
-- ---------------------------------------------------------------------------
create or replace function public.finance_record_credit_note(p_invoice uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_inv public.finance_invoices; v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2);
        v_credited numeric(12,2); v_id uuid; v_m public.finance_missions;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_inv from public.finance_invoices where id = p_invoice for update;
  if v_inv.id is null or v_inv.kind <> 'facture' then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  if v_inv.cancelled_at is not null then raise exception 'Facture annulée' using errcode = '22023'; end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  select coalesce(sum(amount_ttc), 0) into v_credited from public.finance_invoices
   where credited_invoice_id = p_invoice and cancelled_at is null;
  if v_ttc + v_credited > v_inv.amount_ttc then
    raise exception 'Le total des avoirs dépasserait le montant de la facture' using errcode = '22023';
  end if;
  insert into public.finance_invoices (kind, company_id, mission_id, credited_invoice_id, reference, issue_date, amount_ht, vat_amount, amount_ttc, note)
  values ('avoir', v_inv.company_id, v_inv.mission_id, v_inv.id, public.finance_txt(p_data, 'reference'),
          coalesce(public.finance_date(p_data, 'issue_date'), public.today_paris()), v_ht, v_vat, v_ttc, public.finance_txt(p_data, 'note'))
  returning id into v_id;
  if coalesce((p_data ->> 'reduce_revenue')::boolean, false) and v_inv.mission_id is not null then
    select * into v_m from public.finance_missions where id = v_inv.mission_id for update;
    if v_m.kind = 'ponctuel' and v_m.amount is not null then
      update public.finance_missions set amount = greatest(amount - v_ht, 0) where id = v_m.id;
    end if;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_record_credit_note', jsonb_build_object('id', v_id));
end;
$$;

-- ===========================================================================
-- Vue des revenus : facturé brut (billed_ht, hors avoirs) pour le « reste à facturer » (C05 d), et état
-- d'encaissement commun à Finance et Ventes (C05 a) :
--   ponctuel : prevu · a_verifier (date passée, rien facturé) · a_encaisser · en_retard · partiel · encaisse
--   mensuel  : prevu (aucune échéance due) · a_jour · partiel · en_retard · termine
-- ===========================================================================
create or replace view public.finance_mission_overview with (security_invoker = true) as
  select m.*,
         c.name as company_name,
         (coalesce(sum(o.amount_ht) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ht) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ht,
         (coalesce(sum(o.amount_ttc) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ttc) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ttc,
         coalesce(sum(o.paid_net) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)::numeric(12,2) as received,
         coalesce(sum(o.balance), 0)::numeric(12,2) as remaining,
         coalesce(sum(o.amount_ht) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)::numeric(12,2) as billed_ht
    from public.finance_missions m
    join public.companies c on c.id = m.company_id
    left join public.finance_invoice_overview o on o.mission_id = m.id
   group by m.id, c.name;

create or replace function public.finance_revenue_state(p_mission uuid, p_today date default null)
returns text
language plpgsql
stable
as $$
declare
  m public.finance_mission_overview; v_today date := coalesce(p_today, public.today_paris());
  v_late boolean; v_open boolean; v_any_due boolean := false; d date; k int;
begin
  select * into m from public.finance_mission_overview where id = p_mission;
  if m.id is null then return null; end if;
  select bool_or(o.status = 'en_retard'), bool_or(o.status in ('a_encaisser', 'partielle'))
    into v_late, v_open
    from public.finance_invoice_overview o where o.mission_id = m.id and o.kind = 'facture' and o.cancelled_at is null;
  if coalesce(v_late, false) then return 'en_retard'; end if;
  if m.kind = 'recurrent' then
    if m.status = 'termine' or (m.end_date is not null and m.end_date < v_today) then return 'termine'; end if;
    if coalesce(m.start_date, m.next_due_date) is not null then
      for k in 0..600 loop
        d := public.finance_due_date(coalesce(m.start_date, m.next_due_date), m.frequency, k);
        exit when d >= v_today or (m.end_date is not null and d > m.end_date);
        v_any_due := true;
        if not public.finance_due_covered(m.id, d) then return 'en_retard'; end if;
      end loop;
    end if;
    if coalesce(v_open, false) then return 'partiel'; end if;
    return case when v_any_due then 'a_jour' else 'prevu' end;
  end if;
  -- ponctuel
  if m.billed_ht > 0 and (m.amount is null or m.billed_ht >= m.amount) and m.remaining <= 0 then return 'encaisse'; end if;
  if m.received > 0 then return 'partiel'; end if;
  if coalesce(v_open, false) then return 'a_encaisser'; end if;
  return case when coalesce(m.next_due_date, m.start_date) < v_today then 'a_verifier' else 'prevu' end;
end;
$$;

-- ===========================================================================
-- Q07 — montant affiché : estimé avant la clôture ; après Gagné, celui du revenu confirmé (« X € / mois » pour
-- un mensuel). L'ancien montant estimé reste dans l'historique.
-- ===========================================================================
alter table public.companies add column if not exists amount_recurring boolean not null default false;

create or replace function public.sale_sync_deal_amount(p_sale uuid)
returns void
language plpgsql
as $$
declare s public.sales; m public.finance_missions; c public.companies; v_fmt text;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.state <> 'won' or s.mission_id is null then return; end if;
  select * into m from public.finance_missions where id = s.mission_id;
  select * into c from public.companies where id = s.company_id;
  if m.amount is null or c.id is null or c.deal_status <> 'won' then return; end if;
  if c.amount is not distinct from m.amount and c.amount_recurring = (m.kind = 'recurrent') then return; end if;
  update public.companies set amount = m.amount, amount_recurring = (m.kind = 'recurrent') where id = c.id;
  v_fmt := regexp_replace(translate(to_char(m.amount, 'FM999,999,999,990.00'), ',.', ' ,'), ',00$', '') || ' €'
           || case when m.kind = 'recurrent' then ' / mois' else '' end;
  perform public.log_event(c.id, 'system',
    'Montant confirmé : ' || v_fmt
    || coalesce(' (estimé avant clôture : ' || regexp_replace(translate(to_char(c.amount, 'FM999,999,999,990.00'), ',.', ' ,'), ',00$', '') || ' €'
                || case when c.amount_recurring then ' / mois' else '' end || ')', ''),
    jsonb_build_object('sale_id', s.id, 'previous_amount', c.amount, 'amount', m.amount, 'recurring', m.kind = 'recurrent'));
end;
$$;

create or replace function public.tg_sales_sync_amount()
returns trigger
language plpgsql
as $$
begin
  perform public.sale_sync_deal_amount(new.id);
  return null;
end;
$$;
drop trigger if exists sales_sync_amount on public.sales;
create trigger sales_sync_amount after insert or update of mission_id, state on public.sales
  for each row execute function public.tg_sales_sync_amount();

create or replace function public.tg_finance_mission_sync_amount()
returns trigger
language plpgsql
as $$
declare s uuid;
begin
  for s in select id from public.sales where mission_id = new.id and state = 'won' loop
    perform public.sale_sync_deal_amount(s);
  end loop;
  return null;
end;
$$;
drop trigger if exists finance_mission_sync_amount on public.finance_missions;
create trigger finance_mission_sync_amount after update of amount, kind on public.finance_missions
  for each row execute function public.tg_finance_mission_sync_amount();

-- La liste des fiches (Kanban, Prospection, export) expose l'unité du montant : colonne ajoutée en fin de vue.
do $$
declare v text; i int;
begin
  v := pg_get_viewdef('public.company_overview'::regclass, false);
  if position('amount_recurring' in v) > 0 then return; end if;
  i := position(E'\n   FROM ' in v);
  if i = 0 then raise exception 'company_overview : forme inattendue'; end if;
  execute 'create or replace view public.company_overview with (security_invoker = true) as '
          || substr(v, 1, i - 1) || ', c.amount_recurring' || substr(v, i);
end $$;

-- Hors Gagné, le montant est une estimation totale.
create or replace function public.tg_companies_amount_kind()
returns trigger
language plpgsql
as $$
begin
  if new.deal_status is distinct from 'won' or new.amount is null then new.amount_recurring := false; end if;
  return new;
end;
$$;
drop trigger if exists companies_amount_kind on public.companies;
create trigger companies_amount_kind before update of amount, deal_status, amount_recurring on public.companies
  for each row execute function public.tg_companies_amount_kind();

-- Ventes lit le même état d'encaissement que Finance (« Encaissé » seulement quand tout est facturé et réglé).
drop view if exists public.sales_overview;
create view public.sales_overview with (security_invoker = true) as
  with rows as (
    -- ventes (cycles) gagnées, en cours de suivi ou terminées
    select s.id as row_id, c.id as company_id, s.id as sale_id, s.cycle, s.state as sale_state,
           case when s.state = 'lost' then 'lost' else 'won' end as deal_status,
           s.closed_on, s.signed_on, s.revenue_mode, s.documents_ready, s.mission_id, s.project_id, s.project_removed_at
      from public.sales s join public.companies c on c.id = s.company_id
     where c.merged_into_id is null and s.state in ('won', 'completed')
    union all
    -- fiches perdues (avec la vente du cycle perdu s'il y en a une)
    select c.id, c.id, ls.id, ls.cycle, ls.state, 'lost',
           (c.deal_closed_at at time zone 'Europe/Paris')::date, ls.signed_on, ls.revenue_mode, ls.documents_ready, ls.mission_id, ls.project_id, ls.project_removed_at
      from public.companies c
      left join lateral (select * from public.sales x where x.company_id = c.id and x.state = 'lost' order by x.cycle desc limit 1) ls on true
     where c.merged_into_id is null and c.deal_status = 'lost'
    union all
    -- anciens dossiers gagnés sans vente enregistrée (aucune création automatique)
    select c.id, c.id, null, null, null, 'won',
           (c.deal_closed_at at time zone 'Europe/Paris')::date, null, null, null, null, null, null
      from public.companies c
     where c.merged_into_id is null and c.deal_status = 'won'
       and not exists (select 1 from public.sales x where x.company_id = c.id and x.state in ('won', 'reopened'))
  )
  select r.row_id,
         c.id as company_id,
         c.name,
         r.deal_status,
         c.deal_status as company_deal_status,
         c.deal_closed_at,
         r.closed_on,
         c.lost_reason,
         c.amount as deal_amount,
         c.archived_at,
         pl.name as pipeline_name,
         st.name as stage_name,
         pp.name as primary_person_name,
         r.sale_id,
         r.cycle,
         r.sale_state,
         r.signed_on,
         r.revenue_mode,
         r.documents_ready,
         r.project_removed_at,
         ob.status as prep_status,
         ob.open_required as prep_missing,
         ob.prep_error,
         mo.id as mission_id,
         mo.kind as mission_kind,
         mo.amount as mission_amount,
         mo.start_date as mission_start,
         mo.end_date as mission_end,
         mo.status as mission_status,
         mo.invoiced_ttc,
         mo.received,
         mo.remaining,
         pr.id as project_id,
         pr.name as project_name,
         pr.status as project_status,
         case when r.sale_id is null and r.deal_status = 'won' then lm.mission_id end as candidate_mission_id,
         case when r.sale_id is null and r.deal_status = 'won' then lp.project_id end as candidate_project_id,
         case when mo.id is null then 'a_renseigner' else public.finance_revenue_state(mo.id) end as billing,
         mo.billed_ht,
         c.amount_recurring,
         case
           when r.deal_status <> 'won' then null
           when r.sale_state = 'completed' then 'termine'
           when pr.status in ('termine', 'archive') then 'termine'
           when pr.status in ('en_cours', 'en_attente') then 'en_mission'
           when r.sale_id is null and pr.id is null then null
           when r.sale_id is not null and not r.documents_ready then 'devis_contrat'
           else 'onboarding'
         end as stage
    from rows r
    join public.companies c on c.id = r.company_id
    left join public.pipelines pl on pl.id = c.pipeline_id
    left join public.stages st on st.id = c.stage_id
    left join lateral (
      select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as name
        from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1) pp on true
    left join lateral (
      select case when count(*) = 1 then min(m.id::text)::uuid end as mission_id
        from public.finance_missions m
       where m.company_id = c.id and not exists (select 1 from public.sales x where x.mission_id = m.id)) lm on true
    left join lateral (
      select case when count(*) = 1 then min(p.id::text)::uuid end as project_id
        from public.projects p where p.company_id = c.id and p.status <> 'archive'
         and not exists (select 1 from public.sales x where x.project_id = p.id)) lp on true
    left join public.finance_mission_overview mo on mo.id = r.mission_id
    left join public.projects pr on pr.id = coalesce(r.project_id, case when r.sale_id is null and r.deal_status = 'won' then lp.project_id end)
    left join public.project_onboarding_status ob on ob.project_id = pr.id;
revoke all on public.sales_overview from anon;
grant select on public.sales_overview to authenticated;

-- ===========================================================================
-- Droits
-- ===========================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_due_covered(uuid, date, uuid)', 'public.finance_nearest_open_due(uuid, date, uuid)',
    'public.finance_revenue_state(uuid, date)', 'public.sale_sync_deal_amount(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.tg_finance_invoice_consistency(), public.tg_finance_mission_consistency(),
  public.tg_sales_mission_company(), public.tg_finance_invoice_cover(), public.tg_sales_sync_amount(),
  public.tg_finance_mission_sync_amount(), public.tg_companies_amount_kind() from public, anon;
revoke all on public.finance_mission_overview from anon;
grant select on public.finance_mission_overview to authenticated;
