-- Audit, lot 9 — performance (K12, E6). Migration additive.

-- L'activité d'une campagne lit les interactions par meta->>'campaign_id' : index dédié (partiel, petites entrées).
create index if not exists interactions_meta_campaign on public.interactions ((meta ->> 'campaign_id'))
  where meta ? 'campaign_id';

-- Pages Finance : la génération des échéances d'abonnement n'écrit (ni ne verrouille) que si une échéance est due.
create or replace function public.finance_generate_occurrences(p_until date)
returns int
language plpgsql
as $$
declare s public.finance_subscriptions; v_date date; v_n int := 0; v_guard int;
begin
  perform public.assert_owner();
  if not exists (select 1 from public.finance_subscriptions where status = 'actif' and next_due_date <= p_until
                   and (end_date is null or next_due_date <= end_date)) then
    return 0; -- lecture seule : rien à créer
  end if;
  for s in select * from public.finance_subscriptions where status = 'actif' and next_due_date <= p_until order by id for update
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

-- Contrat d'abonnement modifié après une génération : les échéances futures non payées suivent le contrat
-- (montant, libellé, catégorie) ; une fin avancée retire celles d'après ; une fréquence changée les régénère.
create or replace function public.tg_subscription_follow_contract()
returns trigger language plpgsql set search_path = '' as $$
declare v_first date;
begin
  if new.frequency is distinct from old.frequency then
    select min(planned_date) into v_first from public.finance_expenses
     where subscription_id = new.id and status = 'a_payer' and planned_date > public.today_paris();
    delete from public.finance_expenses where subscription_id = new.id and status = 'a_payer' and planned_date > public.today_paris();
    if v_first is not null then new.next_due_date := v_first; end if;
    return new;
  end if;
  update public.finance_expenses set amount = new.amount, amount_ht = new.amount_ht, label = new.label, category_id = new.category_id, supplier = new.supplier
   where subscription_id = new.id and status = 'a_payer' and planned_date > public.today_paris();
  if new.end_date is not null then
    delete from public.finance_expenses where subscription_id = new.id and status = 'a_payer' and planned_date > new.end_date;
  end if;
  return new;
end; $$;
drop trigger if exists subscription_follow_contract on public.finance_subscriptions;
create trigger subscription_follow_contract before update of amount, amount_ht, label, category_id, supplier, frequency, end_date on public.finance_subscriptions
  for each row execute function public.tg_subscription_follow_contract();
revoke execute on function public.tg_subscription_follow_contract() from public, anon;
grant execute on function public.finance_generate_occurrences(date) to authenticated;
