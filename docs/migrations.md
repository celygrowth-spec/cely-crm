# Migrations : règles et application

## Comment la production est migrée
Les migrations sont appliquées **à la main dans le SQL Editor de Supabase**, une par une dans l'ordre des noms
(ou `supabase/install.sql` sur un projet vide). La production n'a donc pas d'historique tenu par la CLI
(`supabase_migrations.schema_migrations`) : renommer un fichier ne désynchronise rien.

## Règles
- Nom : `AAAAMMJJhhmmss_sujet.sql`, **version unique** (test `tests/db/migrations.test.ts`).
- Toujours **après la dernière version existante**, même si sa date est dans le futur : l'ordre d'application est
  l'ordre des noms, la date réelle n'a pas d'effet. Les migrations du chantier d'audit commencent à
  `20261115000100`.
- Additives : aucune donnée réelle modifiée sans rattrapage documenté et testé.
- Une fonction modifiée est **redéfinie entièrement** (`create or replace function` avec tout son corps), jamais
  par remplacement de texte dans sa définition.
- `supabase/install.sql` est régénéré par `npm run db:bundle` (le test échoue s'il est en retard).
- Chaque chantier vérifie : installation complète sur base vide, et **mise à niveau** depuis l'état précédent avec
  des données en place (`applyMigrations` dans `tests/db/harness.ts`).

## C15 — correction appliquée (11/11/2026)
- `20261108000100_fireflies.sql` → **`20261108000150_fireflies.sql`** : la version n'est plus en double et l'ordre
  d'application est inchangé (après `20261108000100_finance_revenus`, avant `20261108000200_fireflies_rattachement`).
  Rien à exécuter en production : le contenu est identique et déjà appliqué.
- Dates futures (`20261112…` à `20261114…`) : sans effet sur l'ordre ; conservées. Les nouvelles migrations sont
  numérotées après elles.
- `20261110000200_mcp_espaces_client.sql` modifie 13 fonctions par remplacement de texte. Aucune migration
  ultérieure ne les redéfinit ; un test vérifie qu'elles gardent leur contrôle (`public.assert_owner()`). Toute
  future modification de l'une d'elles doit la redéfinir entièrement.

## Si vous passez un jour à `supabase db push`
La CLI considérera toutes les migrations comme non appliquées. Avant le premier `db push`, marquez-les appliquées
sans les exécuter : `supabase migration repair --status applied <version>` pour chaque version déjà présente en
production (la liste est celle des fichiers jusqu'à la dernière migration appliquée à la main).

## Ouverture du connecteur Claude (26/11/2026)
- `20261129090000_onboarding_ensure_reparation.sql` : recrée `onboarding_ensure` (introuvable par l'API en
  production), remet ses droits et termine par `notify pgrst, 'reload schema'`. Rejouable sans risque.
- `20261129100000_mcp_ouverture.sql` : onboarding de l'offre découverte en écriture (origine de chaque valeur, voir
  `docs/onboarding-offre-decouverte.md`) et lecture des appels et emails d'une fiche (`company_calls`,
  `company_call_transcript`, `company_mail_list`, `company_mail_thread`). `discovery_target_save` change de signature
  (anciens paramètres conservés, deux nouveaux facultatifs) : l'ancienne fonction est supprimée dans la même migration
  pour ne pas laisser deux variantes que l'API ne saurait pas départager.
- **Après toute migration appliquée dans le SQL Editor qui crée ou modifie une fonction**, exécutez
  `notify pgrst, 'reload schema';` : sans cela, l'API peut répondre « Could not find the function … in the schema
  cache » alors que la fonction existe.

## Rattrapage de la préparation de projet (26/11/2026)
- **Constat** : la production avait reçu la première version du module (`20261112000100_projet_onboarding`, fondée
  sur `deal_closings`). Le fichier a ensuite été réécrit et renommé `20261114000100` (fondé sur les ventes) sans être
  rejoué en base. Les migrations suivantes s'appliquaient sans erreur, mais tout ce qui lit
  `project_onboarding.sale_id` échouait à l'exécution.
- `20261129110000_projet_onboarding_rattrapage.sql` amène cette base à l'état du dépôt : colonne `sale_id` (remplie
  d'après les ventes), vue `project_onboarding_status` recréée (et `sales_overview`, qui la lit, à l'identique),
  déclencheur `sales_onboarding`, `onboarding_prepare` et `onboarding_prep_failed` redéfinies, ancien circuit
  (`project_win_deal`, `tg_deal_closing_reopen`) retiré. `deal_closings` et `closing_id` sont conservés, inutilisés.
  Sans effet sur une base déjà à jour. Test : `tests/db/projet-onboarding-rattrapage.test.ts`, qui reconstruit l'état
  de la production à partir de `tests/db/fixtures/projet_onboarding_ancienne_version.sql`.
- **Règle** : une migration déjà appliquée en production ne se réécrit jamais. Toute correction passe par une
  nouvelle migration, sinon la base et le dépôt divergent sans qu'aucune erreur ne le signale.
