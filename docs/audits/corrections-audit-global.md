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
| K10 | 1/7 | ✅ | Lot 1 : état de préparation à source unique (`project_onboarding_status`, lu par Ventes et Projets ; ancienne préparation TS retirée) ; une proposition ou un contrat ajouté relance la préparation (corrections conservées) ; un contrat reste une pièce à examiner. Reste au lot 7 : lecture du contenu des documents Lot 7 : contenu réellement lu (PDF à texte intégré, Word .docx, texte) et conservé avec son statut (lu, vide/scanné, format non lu, échec) ; la proposition retenue fait référence ; contenu donné à Claude (`open_project_onboarding`) et statut affiché dans la préparation ; une nouvelle pièce est lue à la préparation suivante (corrections conservées) | `ventes-cycles.test.ts` (K10), `ventes.test.ts` | lot 1 | — |
| C02 | 2 | ✅ | `merge_companies` rattache tout (ventes renumérotées, revenus, factures, règlements, projets, rendez-vous, fichiers, emails, appels, diagnostics, temps) ; aperçu `merge_preview` (comptes, points d'attention, blocages) affiché avant confirmation ; deux ventes en cours = blocage expliqué ; issue gardée incompatible avec la vente en cours = refus. Fusions passées : diagnostic en lecture seule + rattrapage idempotent qui laisse les cas ambigus | `fusion.test.ts` (rattachement complet, blocage, renumérotation, diagnostic + rattrapage), navigateur `tests/e2e/lot2-fusion.cjs` | lot 2 | Rattrapage en production : sur instruction |
| C04 | 3 | ✅ | Contrôles en base pour tous les chemins (déclencheurs vérifiés en fin de transaction) : facture ↔ revenu ↔ vente ↔ client ; revenu lié à une vente ou facturé : pas de changement de client ; modification partielle (champ absent inchangé, `null` = retirer) ; facture rattachée à l'échéance libre la plus proche, jamais à une échéance déjà facturée ; référence unique par client ; formulaire de facture de Finance › Clients reçoit enfin les factures | `finance-coherente.test.ts` (C04), navigateur `tests/e2e/lot3-finance.cjs` (échéance proposée libre) | lot 3 | — |
| C05 | 3 | ✅ | État d'encaissement unique en base (`finance_revenue_state`) et dans l'interface, lu par Ventes : « Encaissé » seulement si tout est facturé et réglé ; « Partiellement encaissé » / « À jour » / « Partiellement réglé » / « En retard » ; revenus terminés exclus du mensuel récurrent et des clients actifs ; annulation d'un paiement remboursé refusée ; avoir sans effet sur le reste à facturer, réduction du revenu sur décision explicite | `finance-coherente.test.ts`, `tests/unit/finance-coherente.test.ts`, navigateur | lot 3 | — |
| Q06 | 3 | ✅ | Acompte puis « Encaisser le solde (X €) » en un clic, reste affiché ; plafond = montant prévu ; facture liée à un mensuel au passage Gagné rattachée à l'échéance la plus proche | `finance-coherente.test.ts` (Q06), navigateur | lot 3 | — |
| Q07 | 3 | ✅ | Montant estimé avant clôture ; après Gagné, montant du revenu confirmé (« X € / mois », `companies.amount_recurring`), suivi des modifications du revenu ; estimation conservée dans l'historique ; export avec l'unité ; vocabulaire « revenu » dans Finance | `finance-coherente.test.ts` (Q07), navigateur (fiche, export) | lot 3 | — |
| K02 | 3 | ✅ | Un seul composant et une seule règle de revenu (`RevenueTerms`, `revenueTermsError`) pour Finance › Revenus, Revenus par client et « Marquer comme gagné » ; formulaire « Mission » retiré ; « Ajouter un revenu » n'ouvre plus une facture (« Enregistrer une facture ») | navigateur | lot 3 | — |
| Q01 | 4 | ✅ | `todo_items` inclut les tâches de projet attribuées à moi (projets actifs) : « Aujourd'hui », compteur du menu et prochaine action de la fiche ; validation sur la tâche d'origine (projet) | `aujourdhui.test.ts` (Q01), navigateur `tests/e2e/lot4-aujourdhui.cjs` | lot 4 | — |
| K01 | 4 | ✅ | Une page « Aujourd'hui » à la racine (1re entrée du menu) : tâches CRM et de projet, relances avec Focus, réponses à traiter, appels à rattacher ; filtre aujourd'hui / 7 jours / tout ; `/a-faire` et `/prospection/aujourdhui` redirigent ; « À faire » retiré du menu | navigateur (redirections, compteur) | lot 4 | — |
| Q04 | 4 | ✅ | « Intéressé » et « RDV obtenu » demandent une suite (tâche de suivi par défaut, étape, ou rendez-vous déjà planifié) dans Focus, Réponses et le panneau participant ; refus en base sans suite | `aujourdhui.test.ts` (Q04), navigateur | lot 4 | — |
| K06 | 4 | ✅ | Réponse + résultat en une opération (`record_reply` avec résultat) ; clés liées aux paramètres pour réponse, résultat et création de tâche ; Focus n'enchaîne plus deux appels | `aujourdhui.test.ts` (K06), navigateur (double clic : une tâche) | lot 4 | — |
| C07 | 5 | ✅ | `/api/cron` (agenda, rappels, Gmail, Fireflies) et `/api/rendez-vous/reconcile` ouverts au planificateur (secret vérifié dans la route, propriétaire seulement en session) ; reprise après réservation attendue (`after`) ; dernière réussite / erreur par tâche (`scheduled_jobs`, Paramètres › Passages planifiés) ; Vercel Hobby : passage quotidien, planificateur Supabase 15 min prêt (`supabase/maintenance/planificateur.sql`) | `rendez-vous-emails.test.ts` (C07), navigateur `tests/e2e/lot5-rendez-vous.cjs` (401 sans secret, passage lancé et rapporté) | lot 5 | Activation du planificateur 15 min en production : sur instruction |
| C08 | 5 | ✅ | Agenda déconnecté ou sans agenda vérifié : réservation publique et report par l'invité suspendus avec message ; annulation répercutée à la reconnexion ; textes de déconnexion complétés ; révocation réellement constatée (avertissement sinon) | navigateur (page publique et API refusent, 0 rendez-vous créé) | lot 5 | Google réel non testé |
| C09 | 5 | ✅ | Champ piège, limites par connexion (empreinte IP) et par email, trace « déclaré par le visiteur, à confirmer » ; aucune donnée de fiche écrasée (vérifié dans `link_crm`) | `rendez-vous-emails.test.ts` (limites), `rendez-vous.test.ts` | lot 5 | — |
| Q02 | 5 | ✅ | Confirmation, report, annulation : invitation Google à l'invité (`sendUpdates=all`), expéditeur indiqué ; rappels envoyés par Gmail depuis le serveur (file existante : délais et modèles par type, versions, révisions, suspension globale, invalidation après report) avec quota par passage, incertain jamais renvoyé, trace dans l'historique avec la personne | `rendez-vous-emails.test.ts` (trace unique), `rendez-vous-rappels.test.ts` | lot 5 | Envoi Gmail et invitation Google réels non testés (simulés) |
| Q03 | 5 | ✅ | Lecture Gmail autorisée explicitement (reconnexion), initiale bornée, incrémentale, reprise ; rattachement par contact, ambiguïté résolue à la main (conservée), doublons et échos du CRM écartés, automatiques ignorés, relances en pause et réponse dans Aujourd'hui, pièces jointes en métadonnées | `rendez-vous-emails.test.ts` (Q03), `tests/unit/mail-inbound.test.ts` | lot 5 | Lecture Gmail réelle : reconnexion du compte requise |
| C06 | 6 | ✅ | Partage depuis la fiche : dossier choisi et confirmation « N documents deviendront visibles » exigée en base (`project_files_share`) ; commentaires écrits sur une tâche interne restent privés ; titre de la demande d'onboarding choisi pour le client ; tâche issue d'un récapitulatif en brouillon privée jusqu'à sa publication ; slides partagés en une opération | `portail-documents.test.ts`, navigateur `tests/e2e/lot6-portail.cjs` | lot 6 | — |
| Q08 | 6 | ✅ | « Déposer un fichier » dans le détail d'une tâche du portail : le fichier rejoint le projet, rattaché à la tâche ; la demande d'onboarding passe « répondue » (déclencheur existant) | `projets-fichiers.test.ts`, `projet-onboarding.test.ts` ; navigateur non rejoué (dépôt Storage simulé seulement) | lot 6 | Dépôt Storage réel : projet hébergé |
| K11 | 6 | ✅ | Aperçu : avertit si le contact ne voit rien (projet non publié, accès absent ou expiré) ; limite de connexion par code et par connexion (plus de plafond global) ; retrait d'un dépôt par le client = retrait du projet, la pièce reste dans la fiche ; slides atomiques | `portail-documents.test.ts`, navigateur (aperçu) | lot 6 | — |
| C13 | 6 | 🚧 | Mécanisme relu : liens de téléchargement créés côté serveur après contrôle de session et de projet en base (`portal_file_grant`), objet privé, chemin aléatoire non devinable, autorisation Storage limitée à un objet et 60 s, lien signé valable 5 min (non révocable pendant cette durée : limite documentée). Aucun défaut démontré, donc aucune correction | `projets-fichiers.test.ts` (simulé) | — | Vérification sur un Supabase hébergé de test (à créer par vous) |
| K09 | 7 | ✅ | Projet facultatif sur une session de temps (chrono, saisie, modification) et sur un appel Fireflies, contrôlé (même fiche) ; appel déplacé vers une autre fiche = projet retiré ; filtre par projet sur les mêmes sessions (chaque session comptée une fois) ; historique sans projet inchangé | `onboarding-temps-appels.test.ts` (K09), navigateur `tests/e2e/lot7-temps.cjs` | lot 7 | — |
| Q09 | 7 | ✅ | Chrono de plus de 12 h : fin proposée (début + 8 h, jamais après maintenant), modifiable, confirmée ; « fin corrigée » tracée ; toujours arrêtable, même après 7 jours | `onboarding-temps-appels.test.ts` (Q09), navigateur | lot 7 | — |
| K05 | 8/9 | ✅ | « Modèles de séquence » / « Modèles d'email », « Ouvrir Pipelines », promesse d'envois programmés retirée, doc de clôture réécrite ; état MCP limité à ce que le serveur vérifie (« accès accordé », dernière écriture de Claude) | relu, navigateur (agent lot 9) | lot 9, lot 8 | — |
| K14 | 3/8 | ✅ | Lot 3 : prévisions en TTC comme les factures (base des cotisations en HT), arrondis identiques base / interface, Ventes et fiche rafraîchis après une action Finance. Lot 8 : personne retrouvée dans l'historique des emails (contact unique parmi les destinataires) ; appel Fireflies rattaché dès l'ajout du contact ; retours OAuth Gmail fixés par `APP_URL` ; état MCP sans affirmation invérifiable ; webhook : signature officielle, rejeu sans effet (documenté) ; déconnexion Fireflies = plus d'import futur (documenté). Limite : les portées OAuth du MCP ne distinguent pas lecture/écriture côté Supabase, l'accès reste celui du compte propriétaire | `tests/unit/finance-coherente.test.ts` (K14) | lot 3 | — |
| C12 | 8 | ✅ | `APPOINTMENTS_SECRET` documenté comme secret serveur global : usages dérivés, effets d'un changement, procédure de rotation vérifiable ; séparation ultérieure décrite (transition avec ancien et nouveau secret), non faite | `docs/secrets.md` | lot 8 | — |
| C14 | 8 | ✅ | Une règle : une fiche portant du temps passé ou un diagnostic ne se supprime plus en silence (suppression refusée, comme pour ventes, finance, emails) ; fonctions de déclencheur et tables récentes fermées au rôle anonyme ; nouvelles fonctions fermées par défaut ; test : toute fonction anonyme exige la clé serveur, aucune table lisible sans connexion. Claude : mêmes règles qu'avant (suppressions limitées aux espaces client, avec accord explicite) | `acces-anonymes.test.ts` | lot 8 | — |
| K03 | 9 | ✅ | Mobile : 5 entrées (Aujourd'hui, Prospection, Pipelines, Ventes, Projets) + « Plus » (Rendez-vous, Finance, Temps, Mail, Appels, Paramètres, Déconnexion) ; Mail et Appels gardés ; desktop inchangé | navigateur 390×844 (pas de défilement horizontal) | lot 9 | — |
| K04 | 9 | ✅ | Agenda unique Jour / Semaine / Liste ; détail `?rdv=` depuis toutes les vues ; `/rendez-vous/liste?rdv=` (liens déjà écrits dans Google) redirigé ; connexion Google dans Paramètres › Connecteurs (ancienne adresse redirigée) ; nouveaux événements Google pointent vers la vue Liste | navigateur | lot 9 | — |
| K07 | 9 | ✅ | Doublon à la création : saisie conservée, « Ouvrir la fiche existante » (saisie reprise ensuite) ou « Compléter la fiche existante » (seulement les champs vides, sans rien écraser) ; champs secondaires repliés | `tests/unit/complete-existing.test.ts`, navigateur | lot 9 | — |
| K08 | 9 | ✅ | Palette ⌘K : « Aller à… » (9 rubriques) et « Créer… » (fiche, revenu), filtrage sans accents, clavier | `tests/unit/palette-commands.test.ts`, navigateur | lot 9 | — |
| K12 | 9 | ✅ | Graphiques Finance et éditeur d'email chargés à la demande : /finance 372→271 kB, /finance/rentabilite 373→272 kB, /mail/modeles 397→268 kB (JS initial gzip, build de production) ; index `meta->>'campaign_id'` ; pages Finance sans écriture quand rien n'est dû ; échéances d'abonnement qui suivent le contrat modifié | mesure de build, `performance.test.ts` | lot 9 | Temps de réponse non mesuré sur l'hébergement réel |
| K13 | 9 | ✅ | 23 exports inutilisés retirés après vérification (src, tests, scripts, appels dynamiques) ; adaptateurs Rendez-vous/Mail désormais raccordés (rappels) ou listés | tsc, lint, tests | lot 9 | — |

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

## Lot 4 — une seule page « Aujourd'hui »
- Migration `20261115000400_aujourdhui.sql` (vue `todo_items` : colonnes ajoutées en fin ; `nav_counters` ;
  `set_participant_outcome` et `record_reply` : paramètres ajoutés avec valeurs par défaut, appels existants
  inchangés). Description : `docs/aujourdhui.md`.
- Vérifié dans le navigateur (`tests/e2e/lot4-aujourdhui.cjs`) : l'accueil est « Aujourd'hui » ; tâche de projet du
  jour listée et comptée dans le menu ; cochée → terminée dans le projet et retirée de la file ; anciennes adresses
  redirigées ; « RDV obtenu » sur une réponse propose la tâche « Préparer le rendez-vous », double clic = une seule
  tâche, la fiche réapparaît dans « 7 prochains jours ».
- Environnement de test : le simulateur PostgREST charge maintenant les ressources parentes avec alias
  (`company:companies!inner(...)`), comme le vrai PostgREST (la page Réponses ne s'affichait pas en recette locale).

## Lot 5 — rendez-vous et emails
- Migration `20261115000500_rendez_vous_emails.sql` ; nouvelles routes `/api/cron`, pages Paramètres › Passages
  planifiés et Mail › Emails à rattacher. Fréquences : `docs/planificateur.md`.
- Vérifié dans le navigateur (environnement local, Google et Gmail non configurés) : page publique suspendue avec
  message, réservation directe par l'API refusée (aucun rendez-vous créé), `/api/cron` refusé sans autorisation,
  passage lancé par le propriétaire et rapporté (Gmail et Fireflies « non actifs », raison affichée).
- **Simulé seulement** : envoi Gmail des rappels, lecture Gmail, invitations Google.

## Lot 6 — portail et documents
- Migration `20261115000600_portail_documents.sql`.
- Vérifié dans le navigateur (`tests/e2e/lot6-portail.cjs`) : partage d'un contrat à la racine d'un projet publié →
  confirmation affichée, rien de partagé avant, partagé après ; aperçu signalant qu'un contact sans code ne voit rien.
- C13 reste à vérifier sur Storage réel : un lien signé déjà émis reste valable 5 minutes après une révocation d'accès.

## Lot 7 — onboarding réel, temps et appels par projet
- Migration `20261115000700_onboarding_temps_appels.sql` ; dépendances ajoutées : `unpdf` (texte des PDF), `fflate`
  (lecture des .docx), versions figées.
- Vérifié dans le navigateur (`tests/e2e/lot7-temps.cjs`) : chrono démarré sur un projet ; chrono oublié depuis 2 jours
  → fin proposée 8 h après le début, confirmée, session marquée « fin corrigée » ; total du mois 8 h 59 (client), 7 h 59
  en filtrant sur le projet.
- Lecture des documents : testée sur un PDF et un .docx générés (tests unitaires). La routine Claude réelle
  d'analyse n'a pas été lancée (configuration externe) : non vérifié en réel.

## Lot 8 — connecteurs, accès et suppressions
- Migration `20261115000800_connecteurs_suppressions.sql` ; `docs/secrets.md`.
- Défaut démontré par l'inventaire et corrigé : des fonctions de déclencheur (dont certaines ajoutées aux lots 1 et 7)
  et quatre tables récentes restaient ouvertes au rôle anonyme (sans effet exploitable : les déclencheurs ne
  s'appellent pas directement et les tables sont sous RLS). Désormais fermées, et toute nouvelle fonction l'est par défaut.

## Lot 9 — ergonomie, performance, nettoyage
- Interface (K03, K04, K05, K07, K08) et nettoyage (K13) faits par un agent dans une copie séparée, intégrés par fusion
  (`053f512`) ; performance : chargements à la demande (agent) et migration `20261115000900_performance.sql`.
- E5 (liens croisés vente ↔ revenu ↔ projet) : liens existants conservés (Ventes → projet, revenu ; Finance → fiche) ;
  « Revenus par client » renommé. Pas de nouvel écran.

## Recette finale (15 parcours)
« Navigateur » : rejoué dans l'application locale reliée à la base de test (vraies migrations) ; « base » : test
automatisé sur PGlite ; « simulé » : intégration externe remplacée par une réponse simulée ; « réel » : rien n'a été
appelé en réel (Google, Gmail, Fireflies, Claude) — aucune intégration externe n'est vérifiée en réel.

| # | Parcours | Vérification | Où |
| --- | --- | --- | --- |
| 1 | Prospect → campagne → réponse → pipeline | navigateur (réponse → « RDV obtenu » → suite) + base (intéressé → étape) | `lot4-aujourdhui.cjs`, `aujourdhui.test.ts`, `parcours-prospection.test.ts` |
| 2 | Gagné mensuel → Ventes → revenu → projet | navigateur | `lot1-ventes.cjs`, `lot3-finance.cjs` |
| 3 | Ponctuel → acompte → solde | navigateur | `lot3-finance.cjs` |
| 4 | Réouverture et perte avec décisions | navigateur | `lot1-ventes.cjs` |
| 5 | Client existant → nouvelle vente → nouvelle mission | navigateur (3 cycles) | `lot1-ventes.cjs` |
| 6 | Fusion → relations et historique conservés | navigateur + base | `lot2-fusion.cjs`, `fusion.test.ts` |
| 7 | Tâche projet → Aujourd'hui → validation reflétée | navigateur | `lot4-aujourdhui.cjs` |
| 8 | Réservation → notification → report → rappel recalculé | base (rappels recalculés, versions) ; invitation Google et envoi Gmail **simulés** | `rendez-vous-rappels.test.ts`, `rendez-vous-emails.test.ts` |
| 9 | Agenda déconnecté → réservation suspendue | navigateur (page et API) | `lot5-rendez-vous.cjs` |
| 10 | Réponse Gmail → conversation et fiche → campagne en pause | base, messages Gmail **simulés** | `rendez-vous-emails.test.ts`, `mail-inbound.test.ts` |
| 11 | Appel Fireflies → fiche → projet | base | `onboarding-temps-appels.test.ts`, `fireflies-rattachement.test.ts` |
| 12 | Demande d'onboarding → dépôt client → préparation mise à jour | base (dépôt rattaché, demande « répondue ») ; bouton de dépôt du portail non rejoué (Storage simulé) | `projet-onboarding.test.ts`, `projets-fichiers.test.ts` |
| 13 | Document privé → partage explicite → accès client | navigateur + base | `lot6-portail.cjs`, `portail-documents.test.ts` |
| 14 | Chrono → projet → totaux | navigateur | `lot7-temps.cjs` |
| 15 | Action MCP → mêmes règles que l'interface | base (outils MCP, refus Claude sur temps et suppressions) | `mcp*.test.ts`, `migrations.test.ts` (garde-fou des fonctions) |

**Accès** (`tests/e2e/recette-acces.cjs`, navigateur) : visiteur anonyme renvoyé à la connexion, API 401 ; compte
connecté non propriétaire refusé (pages : `not_owner` ; API : 403 ; fonctions : « Accès refusé ») ; identifiants
inexistants : page introuvable ; fonctions publiques avec une mauvaise clé serveur : refusées. Défense en profondeur
ajoutée pendant la recette : les lectures d'API refusent explicitement un compte non propriétaire (403) au lieu de
renvoyer une liste vide filtrée par la base.

**Contrôles finaux** : 649 tests (unitaires et base, dont installation complète et mise à niveau des migrations depuis
la version auditée avec données), TypeScript, lint, build de production : tout passe. Inspection visuelle : Aujourd'hui
(ordinateur et téléphone 390 px, sans défilement horizontal), Ventes, Revenus, Agenda, Passages planifiés.

## Vérifications encore bloquées
1. **Projet Supabase de test hébergé** (à créer par vous, `docs/environnement-de-test.md`) : C13 (liens de
   téléchargement sur Storage réel), dépôt client réel (Q08), politiques Storage.
2. **Google Agenda réel** : invitations à l'invité (`sendUpdates=all`), suspension et reprise après reconnexion.
3. **Gmail réel** : reconnexion du compte avec la lecture (Q03), envoi des rappels (Q02).
4. **Planificateur toutes les 15 minutes** en production (`supabase/maintenance/planificateur.sql`) : sans lui, les
   rappels ne partent pas (offre Vercel Hobby : un passage par jour).
5. **Routine Claude d'analyse de l'onboarding** sur un dossier contrôlé (K10).
6. **Portées OAuth du MCP** : vérifier sur un vrai jeton quelles portées Supabase émet avant de les exiger.
7. **Rattrapage des fusions passées** et suppression des données [TEST] en production : scripts prêts, sur instruction.
