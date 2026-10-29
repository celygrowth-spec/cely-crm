-- Valeurs initiales de la liste « Source du lead » (modifiables dans Paramètres).
-- Ce ne sont pas des données de démonstration : aucun prospect ni pipeline n'est créé.
insert into public.lead_sources (name, position) values
  ('LinkedIn', 1), ('Email sortant', 2), ('Recommandation', 3), ('Site web', 4), ('Événement', 5), ('Autre', 6)
on conflict do nothing;
