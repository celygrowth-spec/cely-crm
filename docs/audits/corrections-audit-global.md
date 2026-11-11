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
| C01 | 1 | ✅ | Refus en base (`move_company` + déclencheur `companies_closed_guard`) de tout changement d'étape d'une fiche clôturée (sélecteur, Hors pipeline, campagne, Claude) ; sélecteurs désactivés avec explication ; la saisie reste en cas de refus | `cloture.test.ts` (C01), navigateur `tests/e2e/lot1-ventes.cjs` | lot 1 | — |
| C03 | 1 | ✅ | `deal_transition` : réouverture et perte appliquent les décisions (projet continue / en attente / archivé ; échéances continuent / s'arrêtent à une date ; accès portail maintenus / révoqués) en une opération ; refus sans décision ; trace dans l'historique ; une vente regagnée signale revenu arrêté ou projet archivé | `ventes-cycles.test.ts` (C03), navigateur | lot 1 | — |
| C10 | 1 | ✅ | Référence de revenu disparue jamais renvoyée (création sans clé fixe, vente verrouillée) ; suppression d'un revenu lié à une vente bloquée (arrêter les échéances à la place) | `ventes-cycles.test.ts` (C10) | lot 1 | — |
| C11 | 1 | ✅ | Clés liées à l'opération appelante (`idem_get`, `idem_put`) et, pour les opérations critiques, à leurs paramètres (`idem_begin`) : réutilisation ailleurs ou avec d'autres paramètres = erreur explicite | `ventes-cycles.test.ts` (C11) | lot 1 | — |
| Q11 | 1 | ✅ | `sale_set_stage(p_confirm)` : reculer un projet en cours ou en attente demande confirmation ; formalités (documents) ≠ préparation ≠ exécution (projet) | `ventes-cycles.test.ts` (Q11), navigateur (confirmation affichée) | lot 1 | — |
| Q05 | 1 | ✅ | Une vente par cycle (`sales.cycle`, une seule active par fiche) ; « Nouvelle opportunité » ; nouveau Gain = nouvelle vente, nouveau revenu, nouveau projet ; projet terminé jamais réutilisé ; projet supprimé recréé seulement sur demande ; ventes passées dans Gagnées | `ventes-cycles.test.ts` (Q05), navigateur (3 cycles) | lot 1 | — |
| K10 | 1/7 | 🔎 | Lot 1 : état de préparation à source unique (`project_onboarding_status`, lu par Ventes et Projets ; ancienne préparation TS retirée) ; une proposition ou un contrat ajouté relance la préparation (corrections conservées) ; un contrat reste une pièce à examiner. Reste au lot 7 : lecture du contenu des documents | `ventes-cycles.test.ts` (K10), `ventes.test.ts` | lot 1 | — |
| C02 | 2 | ✅ | `merge_companies` rattache tout (ventes renumérotées, revenus, factures, règlements, projets, rendez-vous, fichiers, emails, appels, diagnostics, temps) ; aperçu `merge_preview` (comptes, points d'attention, blocages) affiché avant confirmation ; deux ventes en cours = blocage expliqué ; issue gardée incompatible avec la vente en cours = refus. Fusions passées : diagnostic en lecture seule + rattrapage idempotent qui laisse les cas ambigus | `fusion.test.ts` (rattachement complet, blocage, renumérotation, diagnostic + rattrapage), navigateur `tests/e2e/lot2-fusion.cjs` | lot 2 | Rattrapage en production : sur instruction |
| C04 | 3 | ✅ | Contrôles en base pour tous les chemins (déclencheurs vérifiés en fin de transaction) : facture ↔ revenu ↔ vente ↔ client ; revenu lié à une vente ou facturé : pas de changement de client ; modification partielle (champ absent inchangé, `null` = retirer) ; facture rattachée à l'échéance libre la plus proche, jamais à une échéance déjà facturée ; référence unique par client ; formulaire de facture de Finance › Clients reçoit enfin les factures | `finance-coherente.test.ts` (C04), navigateur `tests/e2e/lot3-finance.cjs` (échéance proposée libre) | lot 3 | — |
| C05 | 3 | ✅ | État d'encaissement unique en base (`finance_revenue_state`) et dans l'interface, lu par Ventes : « Encaissé » seulement si tout est facturé et réglé ; « Partiellement encaissé » / « À jour » / « Partiellement réglé » / « En retard » ; revenus terminés exclus du mensuel récurrent et des clients actifs ; annulation d'un paiement remboursé refusée ; avoir sans effet sur le reste à facturer, réduction du revenu sur décision explicite | `finance-coherente.test.ts`, `tests/unit/finance-coherente.test.ts`, navigateur | lot 3 | — |
| Q06 | 3 | ✅ | Acompte puis « Encaisser le solde (X €) » en un clic, reste affiché ; plafond = montant prévu ; facture liée à un mensuel au passage Gagné rattachée à l'échéance la plus proche | `finance-coherente.test.ts` (Q06), navigateur | lot 3 | — |
| Q07 | 3 | ✅ | Montant estimé avant clôture ; après Gagné, montant du revenu confirmé (« X € / mois », `companies.amount_recurring`), suivi des modifications du revenu ; estimation conservée dans l'historique ; export avec l'unité ; vocabulaire « revenu » dans Finance | `finance-coherente.test.ts` (Q07), navigateur (fiche, export) | lot 3 | — |
| K02 | 3 | ✅ | Un seul composant et une seule règle de revenu (`RevenueTerms`, `revenueTermsError`) pour Finance › Revenus, Revenus par client et « Marquer comme gagné » ; formulaire « Mission » retiré ; « Ajouter un revenu » n'ouvre plus une facture (« Enregistrer une facture ») | navigateur | lot 3 | — |
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
| K14 | 3/8 | 🔎 | Lot 3 : prévisions en TTC comme les factures (base des cotisations en HT), arrondis identiques base / interface, Ventes et fiche rafraîchis après une action Finance. Reste au lot 8 : points d'intégration (MCP, Gmail, Fireflies, webhook) | `tests/unit/finance-coherente.test.ts` (K14) | lot 3 | — |
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

## Lot 1 — ventes protégées
- Migration `20261115000100_ventes_cycles.sql` (additive : les ventes existantes deviennent le cycle 1, liens conservés).
- Vérifié dans le navigateur (`tests/e2e/lot1-ventes.cjs`) : sélecteur verrouillé après Gagné ; réouverture avec
  décisions (projet mis en attente) ; perte avec projet archivé, revenu mensuel arrêté et accès client révoqué ;
  client qui revient (3 ventes successives, nouveau projet à chaque gain) ; recul d'un projet en cours avec
  confirmation ; perte simple depuis le Kanban.
- Défaut trouvé et corrigé pendant la recette : une nouvelle vente se rattachait au projet terminé de la vente
  précédente (présélection du formulaire et absence de contrôle en base).

## Lot 2 — fusion complète
- Migration `20261115000200_fusion_complete.sql` ; scripts `supabase/maintenance/diagnostic-fusions.sql` et
  `rattrapage-fusions.sql` (procédure : `docs/fusion-fiches.md`). Non exécutés en production.
- Vérifié dans le navigateur : deux fiches gagnées → blocage affiché, bouton désactivé ; doublon avec projet,
  rendez-vous et personne → aperçu exact, tout rattaché, l'ancien identifiant redirige.
- Défauts trouvés en cours de route : les rendez-vous (RLS) et un `CASE` non parenthésé dans une condition PL/pgSQL
  empêchaient le déplacement ; corrigés et couverts par les tests.

## Lot 3 — Finance cohérente
- Migration `20261115000300_finance_coherente.sql` (additive : une colonne `companies.amount_recurring`, fonctions,
  déclencheurs, vues `finance_mission_overview` + `billed_ht`, `company_overview` + `amount_recurring`,
  `sales_overview` reconstruite). Règles : `docs/finance-coherence.md`.
- Vérifié dans le navigateur (`tests/e2e/lot3-finance.cjs`) : revenu créé depuis « Revenus par client » avec le
  formulaire commun ; acompte de 1 000 € sur 3 000 € → « Partiellement encaissé » et « Encaisser le solde (2 000 €) » ;
  solde → « Encaissé » ; avoir avec choix explicite sur le revenu ; Gagné mensuel sur une fiche estimée à 12 000 € →
  « 1 000 € / mois » sur la fiche et dans l'export, estimation dans l'historique ; facture saisie sur un mensuel →
  échéance libre proposée.
- Défaut trouvé pendant la recette : le rattrapage des fusions (lot 2) déplaçait le revenu et le projet d'une vente
  laissée en place dans un cas ambigu ; un cas ambigu ne déplace désormais plus rien. Les données issues des
  anciennes fusions (revenu déplacé, vente restée) ne bloquent pas l'installation ; le rattrapage les réunit.
