-- Module Finance : missions, factures (émises ailleurs, seulement enregistrées), paiements,
-- charges et abonnements, périodes URSSAF, réglages datés.
-- Migration additive : aucune table existante n'est modifiée ni vidée. Les clients sont les
-- fiches CRM (companies) : aucune seconde base clients.
-- Montants : numeric(12,2) en euros. Les calculs d'agrégats sont faits en centimes entiers
-- côté TypeScript (src/lib/finance/*).

-- ---------------------------------------------------------------------------
-- Réglages (versions datées : l'historique n'est jamais réécrit)
-- ---------------------------------------------------------------------------

create table public.finance_settings (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null unique,
  -- micro_bnc_ssi : micro-entrepreneur, BNC, régime général de la Sécurité sociale (SSI)
  -- micro_bnc_cipav, micro_bic_services, micro_bic_vente : taux à saisir par l'utilisateur
  -- manual : autre statut (EI au réel, SASU, EURL…) → suivi manuel, aucun calcul
  regime text not null default 'micro_bnc_ssi'
    check (regime in ('micro_bnc_ssi','micro_bnc_cipav','micro_bic_services','micro_bic_vente','manual')),
  periodicity text not null default 'monthly' check (periodicity in ('monthly','quarterly')),
  acre boolean not null default false,
  versement_liberatoire boolean not null default false,
  vat_enabled boolean not null default false,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

-- Taux en pourcentage (25.600 = 25,6 %), avec date d'effet et source.
create table public.finance_rates (
  id uuid primary key default gen_random_uuid(),
  regime text not null check (regime in ('micro_bnc_ssi','micro_bnc_cipav','micro_bic_services','micro_bic_vente')),
  kind text not null check (kind in ('social','cfp')),
  rate numeric(6,3) not null check (rate >= 0 and rate < 100),
  effective_from date not null,
  origin text not null default 'user' check (origin in ('official','user')),
  source_url text check (source_url is null or char_length(source_url) <= 500),
  verified_on date,
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (regime, kind, effective_from)
);

-- Solde de trésorerie d'ouverture (facultatif) : une seule ligne.
create table public.finance_opening_balance (
  id boolean primary key default true check (id),
  amount numeric(12,2) not null,
  as_of date not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Missions (rattachées à une fiche CRM). Un deal gagné n'implique aucun encaissement.
-- ---------------------------------------------------------------------------

create table public.finance_missions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  label text not null check (char_length(btrim(label)) between 1 and 200),
  status text not null default 'actif' check (status in ('a_demarrer','actif','en_pause','termine')),
  kind text not null default 'ponctuel' check (kind in ('ponctuel','recurrent')),
  start_date date,
  end_date date,
  amount numeric(12,2) check (amount is null or amount >= 0),          -- HT ; null = inconnu
  frequency text check (frequency is null or frequency in ('mensuel','trimestriel','annuel')),
  next_due_date date,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'ponctuel' or frequency is not null),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index finance_missions_company on public.finance_missions (company_id);

-- ---------------------------------------------------------------------------
-- Factures et avoirs (émis dans un autre outil, enregistrés ici)
-- ---------------------------------------------------------------------------

create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'facture' check (kind in ('facture','avoir')),
  company_id uuid not null references public.companies (id) on delete restrict,
  mission_id uuid references public.finance_missions (id) on delete set null,
  credited_invoice_id uuid references public.finance_invoices (id) on delete restrict,
  reference text check (reference is null or char_length(reference) <= 100),
  issue_date date not null,
  due_date date,
  amount_ht numeric(12,2) not null check (amount_ht > 0),
  vat_rate numeric(5,2) check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)),
  vat_amount numeric(12,2) check (vat_amount is null or vat_amount >= 0),
  amount_ttc numeric(12,2) not null check (amount_ttc > 0),
  forecast_due_date date,             -- échéance de mission que cette facture couvre
  note text check (note is null or char_length(note) <= 2000),
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_ttc >= amount_ht),
  check (kind = 'facture' or credited_invoice_id is not null),
  check (kind = 'avoir' or credited_invoice_id is null),
  check (due_date is null or due_date >= issue_date)
);
create index finance_invoices_company on public.finance_invoices (company_id);
create index finance_invoices_mission on public.finance_invoices (mission_id);
create index finance_invoices_credited on public.finance_invoices (credited_invoice_id);

-- Paiements reçus (et remboursements versés au client). Jamais supprimés : annulés.
create table public.finance_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices (id) on delete restrict,
  kind text not null default 'paiement' check (kind in ('paiement','remboursement')),
  paid_on date not null,
  amount numeric(12,2) not null check (amount > 0),
  note text check (note is null or char_length(note) <= 1000),
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index finance_payments_invoice on public.finance_payments (invoice_id);

-- ---------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------

create table public.finance_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 80),
  position int not null default 0,
  -- traitement dans le calculateur d'EBITDA indicatif
  ebitda_included boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.finance_expense_categories (name, position, ebitda_included) values
  ('Logiciels et abonnements', 1, true),
  ('Hébergement et infrastructure', 2, true),
  ('Sous-traitance', 3, true),
  ('Marketing', 4, true),
  ('Banque et assurance', 5, true),
  ('Matériel', 6, true),
  ('Déplacements', 7, true),
  ('Cotisations sociales', 8, true),
  ('Autres', 9, true);

-- Abonnements et charges récurrentes : des modèles, jamais comptés eux-mêmes.
-- Leurs échéances sont des lignes de finance_expenses (subscription_id renseigné).
create table public.finance_subscriptions (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  supplier text check (supplier is null or char_length(supplier) <= 200),
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  amount numeric(12,2) check (amount is null or amount >= 0),    -- montant payé à chaque échéance (TTC)
  amount_ht numeric(12,2) check (amount_ht is null or amount_ht >= 0),
  frequency text not null default 'mensuel' check (frequency in ('mensuel','trimestriel','annuel')),
  start_date date not null,
  next_due_date date not null,
  renewal_date date,
  end_date date,                                                   -- résiliation : plus d'échéance après
  status text not null default 'actif' check (status in ('actif','resilie')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  supplier text check (supplier is null or char_length(supplier) <= 200),
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  amount numeric(12,2) check (amount is null or amount >= 0),      -- TTC (montant décaissé) ; null = inconnu
  amount_ht numeric(12,2) check (amount_ht is null or amount_ht >= 0),
  vat_amount numeric(12,2) check (vat_amount is null or vat_amount >= 0),
  planned_date date not null,
  paid_on date,
  status text not null default 'a_payer' check (status in ('a_payer','paye','annule')),
  subscription_id uuid references public.finance_subscriptions (id) on delete restrict,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'paye') = (paid_on is not null)),
  check (status <> 'paye' or amount is not null),
  unique (subscription_id, planned_date)
);
create index finance_expenses_planned on public.finance_expenses (planned_date);

-- ---------------------------------------------------------------------------
-- Périodes URSSAF : trois suivis distincts (estimé / déclaré / payé)
-- ---------------------------------------------------------------------------

create table public.finance_urssaf_periods (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  deadline date,
  deadline_origin text check (deadline_origin is null or deadline_origin in ('regle_officielle','saisie')),
  -- déclaration : valeurs saisies par l'utilisateur, figées (jamais recalculées)
  declared_on date,
  declared_base numeric(12,2) check (declared_base is null or declared_base >= 0),
  declared_amount numeric(12,2) check (declared_amount is null or declared_amount >= 0),
  -- estimation de l'application au moment de la déclaration (historique des écarts)
  estimate_base_at_declaration numeric(12,2),
  estimate_amount_at_declaration numeric(12,2),
  estimate_rate_at_declaration numeric(6,3),
  -- paiement
  paid_on date,
  paid_amount numeric(12,2) check (paid_amount is null or paid_amount >= 0),
  reference text check (reference is null or char_length(reference) <= 100),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_start, period_end),
  check (period_end >= period_start),
  check ((declared_on is null) = (declared_amount is null)),
  check (declared_on is not null or paid_on is null),
  check ((paid_on is null) = (paid_amount is null))
);

-- ---------------------------------------------------------------------------
-- Dates de modification, RLS (mêmes protections que le reste du CRM)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['finance_missions','finance_invoices','finance_subscriptions','finance_expenses','finance_urssaf_periods']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
  end loop;
  foreach t in array array[
    'finance_settings','finance_rates','finance_opening_balance','finance_missions','finance_invoices','finance_payments',
    'finance_expense_categories','finance_subscriptions','finance_expenses','finance_urssaf_periods']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Factures et paiements ne se suppriment pas : on les annule (les totaux restent justes).
drop policy owner_delete on public.finance_invoices;
drop policy owner_delete on public.finance_payments;
drop policy owner_delete on public.finance_urssaf_periods;

-- ---------------------------------------------------------------------------
-- Réglages et taux initiaux (vérifiés le 2026-10-30)
-- ---------------------------------------------------------------------------

-- Réglage confirmé par l'utilisateur le 2026-10-30 : micro-entrepreneur BNC, déclaration
-- mensuelle, sans ACRE ni versement libératoire, sans TVA (franchise en base par défaut).
insert into public.finance_settings (effective_from, regime, periodicity, acre, versement_liberatoire, vat_enabled, note)
values ('2024-01-01', 'micro_bnc_ssi', 'monthly', false, false, false,
        'Réglage initial : micro-entrepreneur BNC (régime général), déclaration mensuelle, sans ACRE ni versement libératoire.');

-- Taux officiels. Sources consultées le 2026-10-30 :
--  https://www.urssaf.fr/accueil/actualites/taux-cotisations-autoentrepeneur.html
--  https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/lessentiel-du-statut.html
--  https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/incident---declarations-des-auto.html
--  (BNC régime général : 24,6 % du 1er janvier au 31 décembre 2025, 25,6 % à partir du 1er janvier 2026 ;
--   contribution à la formation professionnelle des professions libérales : 0,2 %.)
-- Aucun taux n'est encodé pour les autres régimes : l'utilisateur les saisit avec sa source.
insert into public.finance_rates (regime, kind, rate, effective_from, origin, source_url, verified_on, note) values
  ('micro_bnc_ssi', 'social', 24.600, '2025-01-01', 'official',
   'https://www.urssaf.fr/accueil/actualites/taux-cotisations-autoentrepeneur.html', '2026-10-30',
   'Taux global BNC régime général du 1er janvier au 31 décembre 2025'),
  ('micro_bnc_ssi', 'social', 25.600, '2026-01-01', 'official',
   'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/incident---declarations-des-auto.html', '2026-10-30',
   'Taux global BNC régime général à partir du 1er janvier 2026 (24,6 % → 25,6 %)'),
  ('micro_bnc_ssi', 'cfp', 0.200, '2025-01-01', 'official',
   'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/lessentiel-du-statut.html', '2026-10-30',
   'Contribution à la formation professionnelle, professions libérales');

-- ---------------------------------------------------------------------------
-- Fusion de fiches CRM : missions et factures suivent la fiche conservée
-- ---------------------------------------------------------------------------

create or replace function public.tg_finance_follow_merge()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.finance_missions set company_id = new.merged_into_id where company_id = new.id;
    update public.finance_invoices set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger finance_follow_merge after update of merged_into_id on public.companies
  for each row execute function public.tg_finance_follow_merge();

-- ---------------------------------------------------------------------------
-- Utilitaires
-- ---------------------------------------------------------------------------

create or replace function public.finance_add_frequency(p_date date, p_frequency text, p_steps int default 1)
returns date
language sql
immutable
as $$
  select (p_date + (case p_frequency when 'mensuel' then 1 when 'trimestriel' then 3 when 'annuel' then 12 end * p_steps)
                    * interval '1 month')::date;
$$;

create or replace function public.finance_txt(p jsonb, k text)
returns text
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), ''); $$;

create or replace function public.finance_num(p jsonb, k text)
returns numeric
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), '')::numeric(12,2); $$;

create or replace function public.finance_date(p jsonb, k text)
returns date
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), '')::date; $$;

-- ---------------------------------------------------------------------------
-- Missions
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_mission(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid; v_company uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_company := nullif(p_data ->> 'company_id', '')::uuid;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  if p_id is null then
    insert into public.finance_missions (company_id, label, status, kind, start_date, end_date, amount, frequency, next_due_date, note)
    values (v_company, btrim(p_data ->> 'label'), coalesce(public.finance_txt(p_data, 'status'), 'actif'),
            coalesce(public.finance_txt(p_data, 'kind'), 'ponctuel'), public.finance_date(p_data, 'start_date'),
            public.finance_date(p_data, 'end_date'), public.finance_num(p_data, 'amount'),
            public.finance_txt(p_data, 'frequency'), public.finance_date(p_data, 'next_due_date'), public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_missions set
      company_id = v_company, label = btrim(p_data ->> 'label'), status = coalesce(public.finance_txt(p_data, 'status'), status),
      kind = coalesce(public.finance_txt(p_data, 'kind'), kind), start_date = public.finance_date(p_data, 'start_date'),
      end_date = public.finance_date(p_data, 'end_date'), amount = public.finance_num(p_data, 'amount'),
      frequency = public.finance_txt(p_data, 'frequency'), next_due_date = public.finance_date(p_data, 'next_due_date'),
      note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Mission introuvable' using errcode = 'P0002'; end if;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_mission', jsonb_build_object('id', v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Factures, avoirs, paiements
-- ---------------------------------------------------------------------------

-- Enregistre une facture émise ailleurs. Si elle couvre l'échéance d'une mission récurrente,
-- l'échéance suivante de la mission est avancée (prévision seulement, aucun encaissement fictif).
create or replace function public.finance_record_invoice(p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_id uuid; v_company uuid; v_mission uuid; v_m public.finance_missions;
  v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_cover date;
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
    select * into v_m from public.finance_missions where id = v_mission;
    if v_m.id is null or v_m.company_id <> v_company then
      raise exception 'La mission ne correspond pas à ce client' using errcode = '22023';
    end if;
  end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant HT doit être positif' using errcode = '22023'; end if;
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  v_cover := public.finance_date(p_data, 'forecast_due_date');

  insert into public.finance_invoices (company_id, mission_id, reference, issue_date, due_date, amount_ht, vat_rate, vat_amount,
                                       amount_ttc, forecast_due_date, note)
  values (v_company, v_mission, public.finance_txt(p_data, 'reference'), public.finance_date(p_data, 'issue_date'),
          public.finance_date(p_data, 'due_date'), v_ht, nullif(p_data ->> 'vat_rate', '')::numeric(5,2), v_vat, v_ttc,
          v_cover, public.finance_txt(p_data, 'note'))
  returning id into v_id;

  if v_cover is not null and v_m.id is not null and v_m.kind = 'recurrent' and v_m.next_due_date = v_cover then
    update public.finance_missions set next_due_date = public.finance_add_frequency(v_cover, v_m.frequency) where id = v_m.id;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_record_invoice', jsonb_build_object('id', v_id));
end;
$$;

-- Corrige les informations d'une facture (montants compris) tant qu'aucun paiement ne la dépasse.
create or replace function public.finance_update_invoice(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_paid numeric(12,2);
begin
  perform public.assert_owner();
  perform 1 from public.finance_invoices where id = p_id for update;
  if not found then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  select paid_net into v_paid from public.finance_invoice_overview where id = p_id;
  if v_ttc < coalesce(v_paid, 0) then
    raise exception 'Le montant TTC serait inférieur aux paiements déjà reçus' using errcode = '22023';
  end if;
  update public.finance_invoices set
    reference = public.finance_txt(p_data, 'reference'), issue_date = public.finance_date(p_data, 'issue_date'),
    due_date = public.finance_date(p_data, 'due_date'), amount_ht = v_ht, vat_rate = nullif(p_data ->> 'vat_rate', '')::numeric(5,2),
    vat_amount = v_vat, amount_ttc = v_ttc, note = public.finance_txt(p_data, 'note'),
    mission_id = nullif(p_data ->> 'mission_id', '')::uuid
  where id = p_id;
  return jsonb_build_object('id', p_id);
end;
$$;

create or replace function public.finance_cancel_invoice(p_id uuid, p_reason text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if exists (select 1 from public.finance_payments where invoice_id = p_id and cancelled_at is null) then
    raise exception 'Cette facture a des paiements : enregistrez plutôt un avoir ou un remboursement' using errcode = '22023';
  end if;
  update public.finance_invoices set cancelled_at = coalesce(cancelled_at, now()), cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id;
  if not found then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- Avoir : réduit ce que le client doit sans effacer la facture d'origine.
create or replace function public.finance_record_credit_note(p_invoice uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_inv public.finance_invoices; v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2);
        v_credited numeric(12,2); v_id uuid;
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
  return public.idem_put(p_idempotency_key, 'finance_record_credit_note', jsonb_build_object('id', v_id));
end;
$$;

-- Paiement reçu (ou remboursement versé). La clé d'idempotence empêche le double paiement
-- en cas de double clic ; le verrou sur la facture empêche deux paiements simultanés de
-- dépasser le reste dû.
create or replace function public.finance_record_payment(
  p_invoice uuid, p_paid_on date, p_amount numeric, p_kind text default 'paiement', p_note text default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_inv public.finance_invoices; v_o record; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_inv from public.finance_invoices where id = p_invoice for update;
  if v_inv.id is null or v_inv.kind <> 'facture' then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  if v_inv.cancelled_at is not null then raise exception 'Facture annulée : paiement impossible' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  if p_paid_on is null then raise exception 'La date est obligatoire' using errcode = '22023'; end if;
  select * into v_o from public.finance_invoice_overview where id = p_invoice;
  if coalesce(p_kind, 'paiement') = 'paiement' and p_amount > v_o.balance then
    raise exception 'Le paiement (% €) dépasse le reste à encaisser (% €)', p_amount, v_o.balance using errcode = '22023';
  end if;
  if p_kind = 'remboursement' and p_amount > v_o.paid_net then
    raise exception 'Le remboursement dépasse les paiements reçus' using errcode = '22023';
  end if;
  insert into public.finance_payments (invoice_id, kind, paid_on, amount, note)
  values (p_invoice, coalesce(p_kind, 'paiement'), p_paid_on, p_amount, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'finance_record_payment', jsonb_build_object('id', v_id));
end;
$$;

create or replace function public.finance_cancel_payment(p_id uuid)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.finance_payments set cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  if not found then raise exception 'Paiement introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Charges et abonnements
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_expense(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid; v_status text; v_paid date;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_status := coalesce(public.finance_txt(p_data, 'status'), 'a_payer');
  v_paid := case when v_status = 'paye' then coalesce(public.finance_date(p_data, 'paid_on'), public.finance_date(p_data, 'planned_date')) end;
  if v_status = 'paye' and public.finance_num(p_data, 'amount') is null then
    raise exception 'Indiquez le montant payé' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.finance_expenses (label, supplier, category_id, amount, amount_ht, vat_amount, planned_date, paid_on, status, note)
    values (btrim(p_data ->> 'label'), public.finance_txt(p_data, 'supplier'), nullif(p_data ->> 'category_id', '')::uuid,
            public.finance_num(p_data, 'amount'), public.finance_num(p_data, 'amount_ht'), public.finance_num(p_data, 'vat_amount'),
            public.finance_date(p_data, 'planned_date'), v_paid, v_status, public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_expenses set
      label = btrim(p_data ->> 'label'), supplier = public.finance_txt(p_data, 'supplier'),
      category_id = nullif(p_data ->> 'category_id', '')::uuid, amount = public.finance_num(p_data, 'amount'),
      amount_ht = public.finance_num(p_data, 'amount_ht'), vat_amount = public.finance_num(p_data, 'vat_amount'),
      planned_date = public.finance_date(p_data, 'planned_date'), paid_on = v_paid, status = v_status,
      note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_expense', jsonb_build_object('id', v_id));
end;
$$;

-- Valide le paiement d'une charge (seule une charge validée compte comme payée).
create or replace function public.finance_pay_expense(p_id uuid, p_paid_on date, p_amount numeric default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_e public.finance_expenses;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_e from public.finance_expenses where id = p_id for update;
  if v_e.id is null then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  if v_e.status = 'annule' then raise exception 'Charge annulée' using errcode = '22023'; end if;
  if coalesce(p_amount, v_e.amount) is null then raise exception 'Indiquez le montant payé' using errcode = '22023'; end if;
  update public.finance_expenses
     set status = 'paye', paid_on = coalesce(p_paid_on, public.today_paris()), amount = coalesce(p_amount, amount)
   where id = p_id;
  return public.idem_put(p_idempotency_key, 'finance_pay_expense', jsonb_build_object('id', p_id));
end;
$$;

create or replace function public.finance_set_expense_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if p_status not in ('a_payer','annule') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  update public.finance_expenses set status = p_status, paid_on = null where id = p_id;
  if not found then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

create or replace function public.finance_save_subscription(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_id is null then
    insert into public.finance_subscriptions (label, supplier, category_id, amount, amount_ht, frequency, start_date, next_due_date,
                                              renewal_date, end_date, status, note)
    values (btrim(p_data ->> 'label'), public.finance_txt(p_data, 'supplier'), nullif(p_data ->> 'category_id', '')::uuid,
            public.finance_num(p_data, 'amount'), public.finance_num(p_data, 'amount_ht'),
            coalesce(public.finance_txt(p_data, 'frequency'), 'mensuel'),
            coalesce(public.finance_date(p_data, 'start_date'), public.finance_date(p_data, 'next_due_date')),
            coalesce(public.finance_date(p_data, 'next_due_date'), public.finance_date(p_data, 'start_date')),
            public.finance_date(p_data, 'renewal_date'), public.finance_date(p_data, 'end_date'),
            coalesce(public.finance_txt(p_data, 'status'), 'actif'), public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_subscriptions set
      label = btrim(p_data ->> 'label'), supplier = public.finance_txt(p_data, 'supplier'),
      category_id = nullif(p_data ->> 'category_id', '')::uuid, amount = public.finance_num(p_data, 'amount'),
      amount_ht = public.finance_num(p_data, 'amount_ht'), frequency = coalesce(public.finance_txt(p_data, 'frequency'), frequency),
      next_due_date = coalesce(public.finance_date(p_data, 'next_due_date'), next_due_date),
      renewal_date = public.finance_date(p_data, 'renewal_date'), end_date = public.finance_date(p_data, 'end_date'),
      status = coalesce(public.finance_txt(p_data, 'status'), status), note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Abonnement introuvable' using errcode = 'P0002'; end if;
  end if;
  if (select start_date is null or next_due_date is null from public.finance_subscriptions where id = v_id) then
    raise exception 'Indiquez la prochaine échéance' using errcode = '22023';
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_subscription', jsonb_build_object('id', v_id));
end;
$$;

-- Crée les échéances (charges « à payer ») des abonnements jusqu'à p_until inclus.
-- Idempotent : une échéance par abonnement et par date (contrainte unique). Les échéances
-- ne sont comptées comme payées qu'après validation (finance_pay_expense).
create or replace function public.finance_generate_occurrences(p_until date)
returns int
language plpgsql
as $$
declare s public.finance_subscriptions; v_date date; v_n int := 0; v_guard int;
begin
  perform public.assert_owner();
  for s in select * from public.finance_subscriptions where status = 'actif' order by id for update
  loop
    v_date := s.next_due_date;
    v_guard := 0;
    while v_date <= p_until and (s.end_date is null or v_date <= s.end_date) and v_guard < 400 loop
      insert into public.finance_expenses (label, supplier, category_id, amount, amount_ht, planned_date, status, subscription_id)
      values (s.label, s.supplier, s.category_id, s.amount, s.amount_ht, v_date, 'a_payer', s.id)
      on conflict (subscription_id, planned_date) do nothing;
      if found then v_n := v_n + 1; end if;
      v_date := public.finance_add_frequency(v_date, s.frequency);
      v_guard := v_guard + 1;
    end loop;
    if v_date <> s.next_due_date then
      update public.finance_subscriptions set next_due_date = v_date where id = s.id;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- URSSAF : déclaration et paiement (aucune télétransmission, aucun paiement réel)
-- ---------------------------------------------------------------------------

create or replace function public.finance_urssaf_declare(
  p_start date, p_end date, p_declared_on date, p_base numeric, p_amount numeric,
  p_estimate jsonb default '{}', p_deadline date default null, p_deadline_origin text default null,
  p_reference text default null, p_note text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_declared_on is null or p_amount is null then
    raise exception 'Indiquez la date et le montant déclaré' using errcode = '22023';
  end if;
  insert into public.finance_urssaf_periods as u (period_start, period_end, deadline, deadline_origin, declared_on, declared_base, declared_amount,
      estimate_base_at_declaration, estimate_amount_at_declaration, estimate_rate_at_declaration, reference, note)
  values (p_start, p_end, p_deadline, p_deadline_origin, p_declared_on, p_base, p_amount,
          public.finance_num(p_estimate, 'base'), public.finance_num(p_estimate, 'amount'),
          nullif(p_estimate ->> 'rate', '')::numeric(6,3), nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (period_start, period_end) do update set
    declared_on = excluded.declared_on, declared_base = excluded.declared_base, declared_amount = excluded.declared_amount,
    estimate_base_at_declaration = excluded.estimate_base_at_declaration,
    estimate_amount_at_declaration = excluded.estimate_amount_at_declaration,
    estimate_rate_at_declaration = excluded.estimate_rate_at_declaration,
    deadline = coalesce(excluded.deadline, u.deadline), deadline_origin = coalesce(excluded.deadline_origin, u.deadline_origin),
    reference = coalesce(excluded.reference, u.reference), note = coalesce(excluded.note, u.note)
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'finance_urssaf_declare', jsonb_build_object('id', v_id));
end;
$$;

create or replace function public.finance_urssaf_pay(p_id uuid, p_paid_on date, p_amount numeric, p_reference text default null,
                                                     p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_paid_on is null or p_amount is null then raise exception 'Indiquez la date et le montant payé' using errcode = '22023'; end if;
  update public.finance_urssaf_periods
     set paid_on = p_paid_on, paid_amount = p_amount, reference = coalesce(nullif(btrim(coalesce(p_reference, '')), ''), reference)
   where id = p_id and declared_on is not null;
  if not found then raise exception 'Période non déclarée : enregistrez d''abord la déclaration' using errcode = '22023'; end if;
  return public.idem_put(p_idempotency_key, 'finance_urssaf_pay', jsonb_build_object('id', p_id));
end;
$$;

-- Échéance saisie à la main (lorsque la règle officielle ne s'applique pas ou diffère).
create or replace function public.finance_urssaf_set_deadline(p_start date, p_end date, p_deadline date)
returns jsonb
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.finance_urssaf_periods as u (period_start, period_end, deadline, deadline_origin)
  values (p_start, p_end, p_deadline, case when p_deadline is null then null else 'saisie' end)
  on conflict (period_start, period_end) do update
    set deadline = excluded.deadline, deadline_origin = excluded.deadline_origin
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- Corrige une erreur de saisie (retire le paiement ou la déclaration). L'utilisateur peut
-- ensuite ressaisir les bons chiffres ; les calculs de l'application ne réécrivent jamais rien.
create or replace function public.finance_urssaf_reset(p_id uuid, p_what text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if p_what = 'payment' then
    update public.finance_urssaf_periods set paid_on = null, paid_amount = null where id = p_id;
  elsif p_what = 'declaration' then
    update public.finance_urssaf_periods
       set paid_on = null, paid_amount = null, declared_on = null, declared_base = null, declared_amount = null,
           estimate_base_at_declaration = null, estimate_amount_at_declaration = null, estimate_rate_at_declaration = null
     where id = p_id;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Réglages
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_settings(p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_id uuid; v_from date;
begin
  perform public.assert_owner();
  v_from := coalesce(public.finance_date(p_data, 'effective_from'), public.today_paris());
  insert into public.finance_settings as s (effective_from, regime, periodicity, acre, versement_liberatoire, vat_enabled, note)
  values (v_from, p_data ->> 'regime', coalesce(p_data ->> 'periodicity', 'monthly'),
          coalesce((p_data ->> 'acre')::boolean, false), coalesce((p_data ->> 'versement_liberatoire')::boolean, false),
          coalesce((p_data ->> 'vat_enabled')::boolean, false), public.finance_txt(p_data, 'note'))
  on conflict (effective_from) do update set
    regime = excluded.regime, periodicity = excluded.periodicity, acre = excluded.acre,
    versement_liberatoire = excluded.versement_liberatoire, vat_enabled = excluded.vat_enabled, note = excluded.note
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Vues de lecture (security invoker : RLS des tables sous-jacentes)
-- ---------------------------------------------------------------------------

-- Une ligne par facture : payé, avoirs, reste dû et statut calculé.
create or replace view public.finance_invoice_overview with (security_invoker = true) as
  select i.*,
         c.name as company_name,
         m.label as mission_label,
         coalesce(p.paid, 0)::numeric(12,2) as paid,
         coalesce(p.refunded, 0)::numeric(12,2) as refunded,
         (coalesce(p.paid, 0) - coalesce(p.refunded, 0))::numeric(12,2) as paid_net,
         coalesce(cr.credited, 0)::numeric(12,2) as credited,
         case when i.kind = 'avoir' or i.cancelled_at is not null then 0
              else greatest(i.amount_ttc - coalesce(cr.credited, 0) - (coalesce(p.paid, 0) - coalesce(p.refunded, 0)), 0)
         end::numeric(12,2) as balance,
         p.last_paid_on,
         case
           when i.cancelled_at is not null then 'annulee'
           when i.kind = 'avoir' then 'avoir'
           when i.amount_ttc - coalesce(cr.credited, 0) - (coalesce(p.paid, 0) - coalesce(p.refunded, 0)) <= 0 then 'payee'
           when i.due_date is not null and i.due_date < public.today_paris() then 'en_retard'
           when coalesce(p.paid, 0) - coalesce(p.refunded, 0) > 0 then 'partielle'
           else 'a_encaisser'
         end as status
    from public.finance_invoices i
    join public.companies c on c.id = i.company_id
    left join public.finance_missions m on m.id = i.mission_id
    left join lateral (
      select sum(amount) filter (where kind = 'paiement') as paid,
             sum(amount) filter (where kind = 'remboursement') as refunded,
             max(paid_on) filter (where kind = 'paiement') as last_paid_on
        from public.finance_payments where invoice_id = i.id and cancelled_at is null) p on true
    left join lateral (
      select sum(amount_ttc) as credited from public.finance_invoices a
       where a.credited_invoice_id = i.id and a.cancelled_at is null) cr on true;

-- Totaux par mission (facturé net d'avoirs, encaissé, reste).
create or replace view public.finance_mission_overview with (security_invoker = true) as
  select m.*,
         c.name as company_name,
         (coalesce(sum(o.amount_ht) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ht) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ht,
         (coalesce(sum(o.amount_ttc) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ttc) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ttc,
         coalesce(sum(o.paid_net) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)::numeric(12,2) as received,
         coalesce(sum(o.balance), 0)::numeric(12,2) as remaining
    from public.finance_missions m
    join public.companies c on c.id = m.company_id
    left join public.finance_invoice_overview o on o.mission_id = m.id
   group by m.id, c.name;

-- Mouvements de trésorerie réels : source unique des encaissements et décaissements.
-- Une cotisation URSSAF payée y figure une seule fois (depuis la période URSSAF), même si elle
-- est aussi affichée dans les charges. Une charge de catégorie « Cotisations sociales » saisie
-- à la main y figure aussi : l'interface invite à ne pas saisir l'URSSAF en double.
create or replace view public.finance_cash_movements with (security_invoker = true) as
  select p.id, p.paid_on as date,
         case when p.kind = 'paiement' then 'in' else 'out' end as direction,
         case when p.kind = 'paiement' then 'paiement_client' else 'remboursement_client' end as source,
         p.amount,
         case when i.amount_ttc > 0 then round(p.amount * i.amount_ht / i.amount_ttc, 2) else p.amount end::numeric(12,2) as amount_ht,
         i.company_id, null::uuid as category_id, i.id as invoice_id, null::uuid as expense_id, null::uuid as urssaf_period_id,
         coalesce(c.name, '') || coalesce(' · ' || i.reference, '') as label
    from public.finance_payments p
    join public.finance_invoices i on i.id = p.invoice_id
    join public.companies c on c.id = i.company_id
   where p.cancelled_at is null
  union all
  select e.id, e.paid_on, 'out', 'charge', e.amount, coalesce(e.amount_ht, e.amount), null, e.category_id, null, e.id, null, e.label
    from public.finance_expenses e
   where e.status = 'paye'
  union all
  select u.id, u.paid_on, 'out', 'urssaf', u.paid_amount, u.paid_amount, null, null, null, null, u.id,
         'Cotisations URSSAF ' || to_char(u.period_start, 'YYYY-MM') || case when u.period_end > (u.period_start + interval '1 month' - interval '1 day')::date then ' → ' || to_char(u.period_end, 'YYYY-MM') else '' end
    from public.finance_urssaf_periods u
   where u.paid_on is not null;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.finance_invoice_overview, public.finance_mission_overview, public.finance_cash_movements from anon;
grant select on public.finance_invoice_overview, public.finance_mission_overview, public.finance_cash_movements to authenticated;
