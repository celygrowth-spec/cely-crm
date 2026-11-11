# Corrections de l'audit global (rapport du 11/11/2026, commit d5cb064)

Branche : `fix/coherence-globale-crm`. Rapport initial : `docs/audits/audit-global-2026-11-11.md`.
Environnement de recette : `docs/environnement-de-test.md` (base locale aux vraies migrations, données [TEST]).

**État** : ✅ corrigé et vérifié · 🔎 constat vérifié, correction en cours · ⏳ à traiter · 🚧 bloqué (raison indiquée)
· ✔️ déjà correct (vérifié, rien à corriger).

**Preuves** : « test » = test automatisé du dépôt (PGlite + vraies migrations, ou unitaire) ; « navigateur » =
parcours rejoué dans l'application locale reliée à la base de test ; « réel » = intégration externe réellement appelée.

| Id | Lot | État | Correction ou résultat | Tests | Commit | Blocage |
| --- | --- | --- | --- | --- | --- | --- |
| C15 | 0 | ✅ | Version Fireflies en double renommée sans changer l'ordre (`20261108000150`) ; dates futures sans effet sur l'ordre ; règles et procédure CLI dans `docs/migrations.md` ; garde-fou sur les 13 fonctions modifiées par texte | `tests/db/migrations.test.ts` (versions uniques, ordre, bundle à jour, garde-fou, mise à niveau depuis d5cb064 avec données, installation complète) | lot 0 | — |
| Q10 | 0 | ✅ | Script refait : aperçu en lecture seule, suppression en un bloc de tout le périmètre [TEST] (ventes, projets et contenu, finance, rendez-vous, emails, appels, diagnostics, fichiers, temps) ; vrais appels et rendez-vous détachés et conservés ; garde-fous (fusion, pipeline, type de rendez-vous) | `tests/db/delete-test-data.test.ts` (fiche [TEST] gagnée complète, garde-fou fusion) | lot 0 | — |
| C01 | 1 | ⏳ | | | | |
| C03 | 1 | ⏳ | | | | |
| C10 | 1 | ⏳ | | | | |
| C11 | 1 | ⏳ | | | | |
| Q11 | 1 | ⏳ | | | | |
| Q05 | 1 | ⏳ | | | | |
| K10 | 1/7 | ⏳ | | | | |
| C02 | 2 | ⏳ | | | | |
| C04 | 3 | ⏳ | | | | |
| C05 | 3 | ⏳ | | | | |
| Q06 | 3 | ⏳ | | | | |
| Q07 | 3 | ⏳ | | | | |
| K02 | 3 | ⏳ | | | | |
| Q01 | 4 | ⏳ | | | | |
| K01 | 4 | ⏳ | | | | |
| Q04 | 4 | ⏳ | | | | |
| K06 | 4 | ⏳ | | | | |
| C07 | 5 | ⏳ | | | | |
| C08 | 5 | ⏳ | | | | |
| C09 | 5 | ⏳ | | | | |
| Q02 | 5 | ⏳ | | | | |
| Q03 | 5 | ⏳ | | | | |
| C06 | 6 | ⏳ | | | | |
| Q08 | 6 | ⏳ | | | | |
| K11 | 6 | ⏳ | | | | |
| C13 | 6 | ⏳ | | | | |
| K09 | 7 | ⏳ | | | | |
| Q09 | 7 | ⏳ | | | | |
| K05 | 8 | ⏳ | | | | |
| K14 | 8 | ⏳ | | | | |
| C12 | 8 | ⏳ | | | | |
| C14 | 8 | ⏳ | | | | |
| K03 | 9 | ⏳ | | | | |
| K04 | 9 | ⏳ | | | | |
| K07 | 9 | ⏳ | | | | |
| K08 | 9 | ⏳ | | | | |
| K12 | 9 | ⏳ | | | | |
| K13 | 9 | ⏳ | | | | |

## Lot 0 — environnement de test et migrations
- Environnement local versionné (`scripts/test-env/`) : base aux vraies migrations, comptes `owner` / `stranger`,
  données [TEST], application forcée sur cette base. Vérifié dans le navigateur : le propriétaire voit les fiches
  [TEST], le compte étranger est refusé (`not_owner`), un visiteur anonyme est renvoyé à la connexion.
- Projet Supabase hébergé de test : configuration et lanceur prêts (`.env.test.example`, `npm run test-env:hosted`,
  refus si l'URL est celle de la production). **Bloqué : création du projet par vous** (étapes dans
  `docs/environnement-de-test.md`). Les vérifications qui en dépendent (C13, liens signés réels) restent en attente.
