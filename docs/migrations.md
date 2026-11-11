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
