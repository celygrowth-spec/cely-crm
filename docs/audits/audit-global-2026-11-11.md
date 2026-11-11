# Audit global de Cely Growth — connexions, cohérence et simplicité

> Rapport initial, conservé tel quel comme référence du chantier `fix/coherence-globale-crm`.
> Version auditée : `origin/main` au commit `d5cb064` (fusion de la PR #16). Date : 11 novembre 2026.
> Le suivi des corrections est dans `docs/audits/corrections-audit-global.md`.

Nature : lecture du code et des 38 migrations, tests sur base de test en mémoire (PGlite, vraies migrations), build
de production. Aucune donnée réelle lue ou modifiée ; aucun appel vers Google, Gmail, Fireflies ou Claude.

Niveaux de preuve : **Vérifié (test)** · **Lu (code)** · **Hypothèse** · **Config externe** · **Indéterminé**.

## A. Synthèse

### A.1 Ce qui fonctionne bien
- Une seule fiche par entreprise, du prospect au client ; rien n'est copié d'un module à l'autre.
- Règles importantes en base, appelées de la même façon par l'interface et par Claude (anti-doublons, idempotence, verrous).
- Types et lint propres, 579/579 tests, build réussi, 26 tests temporaires des agents réussis.
- Gagné crée vente, revenu et projet en une fois, sans doublon (Vérifié).
- Encaissement en un clic par échéance ; le pipeline n'entre jamais dans les prévisions.
- Cloisonnement du portail solide (Vérifié, 4/4).
- Jetons Gmail/Agenda chiffrés, signatures Fireflies vérifiées, pas de doublon email/événement/appel, rattachement Fireflies prudent.
- Claude (MCP) passe par les mêmes fonctions ; la base lui refuse les actions sensibles (Lu).

### A.2 Principales ruptures
- Vente gagnée rouverte sans le voir par un changement d'étape, « Hors pipeline », Claude ou une campagne (C01).
- Fusion qui oublie projets, rendez-vous et parfois la vente (C02).
- Perte après réouverture : projet ouvert, revenu dans les prévisions (C03).
- Tâches de projet absentes d'À faire (Q01).
- Finance : « Encaissé » trop tôt, revenus terminés comptés, facture rattachée au revenu d'un autre client (C04, C05).
- Rendez-vous : écarts Google jamais rattrapés (C07), invité jamais prévenu (Q02), agenda déconnecté non vérifié (C08).
- Emails reçus absents du CRM (Q03).

### A.3 Sources de complexité
Deux écrans du jour (À faire, Prospection › Aujourd'hui) + Focus + Réponses ; quatre formulaires de revenus ;
11 entrées de menu ; deux systèmes de tâches ; le même état décrit 3-4 fois (fiche, vente, projet, revenu).

### A.4 Les cinq actions à plus fort impact
1. Verrouiller les ventes clôturées ; proposer projet/revenu au passage à Perdu (S-M).
2. Compléter la fusion (M).
3. Une seule page « Aujourd'hui » (M).
4. Fiabiliser Finance (S-M).
5. Fiabiliser Rendez-vous (S-M).

### A.5 Accès manquants
Connecteur MCP local en échec ; aucune base de test reliée (`.env.local` vers la production) ; aucun appel réel
Google/Gmail/Fireflies/Claude ; Vercel invisible (variables, plan, journaux) ; méthode de migration de la production
inconnue (C15) ; stockage hébergé non vérifié (C13) ; pas de données d'usage ; temps de réponse non mesurés ; `gh` absent.

## B. Carte de l'application (résumé)
Fiche (`companies`) au centre : personnes, historique (`interactions`), tâches CRM (`tasks`), prospection.
« Gagné » (`sale_confirm`) → vente (`sales`, une par fiche) → revenu (`finance_missions`) → facture → règlement ;
→ projet (`projects`) → portail (tâches, fichiers, points, idées, onboarding). Rendez-vous (`appt_bookings`),
appels (`fireflies_calls`), emails (`mail_messages`), temps (`time_entries`, fiche seulement).
Quatre indicateurs d'avancement (fiche, vente, projet, revenu) dont seuls les deux premiers sont synchronisés.

## C. Parcours intermodules (statut à l'audit)
1. Prospect → campagne → pipeline : partiel (Q03, K06, Q04).
2. Gagné → Ventes → projet : partiel, cas cassé (C01, Q05, Q11).
3. Gagné → revenu → facture → règlement : partiel (C05, C04, Q06).
4. Préparation de l'onboarding : partiel ; contenu des propositions non lu (K10).
5. Réservation → Google → fiche → projet : partiel (Q02, C07, C08).
6. Fireflies → fiche → historique : vérifié ; projet absent (K09, K14).
7. Email : envoi seulement (Q03, K14, Q02).
8. Tâche → À faire : cassé pour les tâches de projet (Q01).
9. Fichier → projet → portail : partiel (C06, Q08, C02).
10. Chrono → client ou projet : partiel (K09, Q09).
11. Claude (MCP) : mêmes règles, sauf C01.
12. Déconnexion d'un connecteur : partiel (C08, K05, pas de déconnexion Fireflies).

## D. Constats

### D.1 Risques sur les données ou les accès
- **C01** (P1) — Vente gagnée rouverte sans confirmation par changement d'étape, « Hors pipeline », `move_company`
  (Claude), « Intéressé + étape ». Cause : `move_company` force `deal_status = 'open'` (functions.sql:769) ; sélecteur
  jamais désactivé. Vérifié. Correction : refus en base sauf réouverture explicite ; sélecteur désactivé ; message clair.
- **C02** (P1) — Fusion : projets et rendez-vous restent sur la fiche absorbée ; la vente absorbée disparaît si la fiche
  conservée en a une. Cause : `merge_companies` ne traite ni `projects` ni `appt_bookings` ; vente déplacée seulement
  si absente. Vérifié. Correction : tout déplacer, refuser deux ventes, avertir, rattrapage.
- **C03** (P1) — Perte après réouverture : projet ouvert, portail ouvert, revenu actif ; ponctuel non arrêtable ; regagnée,
  un revenu arrêté ne se signale pas. Vérifié. Correction : proposer archivage et arrêt sur confirmation, badges.
- **C04** (P1) — Revenu lié à une vente qui change de client ; facture rattachée au revenu d'un autre client ou déliée
  si le champ manque ; facture de Finance › Clients rattachée à une échéance déjà facturée (prévision comptée 2 fois).
  Cause : `finance_save_mission`, `finance_update_invoice` sans contrôle ; liste des factures non transmise.
- **C05** (P2) — « Encaissé » dès la première facture payée ; revenus terminés comptés ; annulation d'un paiement
  remboursé → encaissé négatif ; un avoir fait remonter le reste à facturer.
- **C06** (P2) — « Partager avec le projet » rend visible sans confirmation ; commentaires internes rendus visibles ;
  titre interne visible ; tâche de récapitulatif brouillon visible.
- **C07** (P2) — Écarts Google jamais rattrapés : pas de cron, route absente des routes publiques du proxy (401),
  reprise non attendue.
- **C08** (P2) — Agenda déconnecté : créneaux sans vérification, report refusé, annulation non répercutée, texte
  incomplet, « révoqué » même en cas d'échec.
- **C09** (P3) — Réservation publique sans protection anti-abus (limite, piège, vérification) ; écrit sur la fiche.
- **C10** (P1) — Revenu de vente supprimé : la clé fixe `sale-revenue:<id>` renvoie l'identifiant supprimé, la vente
  ne peut plus être confirmée. Vérifié.
- **C11** (P3) — `idem_get` ne filtre pas la portée : une clé réutilisée renvoie le résultat d'une autre action.
- **C12** (P3) — Un seul secret (`APPOINTMENTS_SECRET`) pour Google, rendez-vous, Fireflies et portail.
- **C13** (P3, hypothèse) — Téléchargements du portail autorisés par nom de fichier pendant 60 s.
- **C14** (P3) — Suppressions inégales (cascade diagnostic/temps) ; droits MCP de suppression incohérents ; fonctions
  exécutables par tous si une migration oublie de restreindre.
- **C15** (P2) — Numéro de migration en double (`20261108000100_finance_revenus` / `_fireflies`), dates futures,
  modification de 13 fonctions par remplacement de texte (`20261110000200_mcp_espaces_client.sql`).

### D.2 Blocages quotidiens
- **Q01** (P1) — Tâches de projet absentes d'À faire, du compteur et de la prochaine action (`todo_items`).
- **Q02** (P2) — Aucun email automatique (réservation, report, annulation, rappels) ; `sendUpdates=none`.
- **Q03** (P2) — Emails reçus absents (autorisation Gmail limitée à l'envoi).
- **Q04** (P2) — « RDV obtenu » / « Intéressé sans pipeline » : la fiche disparaît de toutes les files.
- **Q05** (P3) — Client qui revient sans parcours ; projet terminé réutilisé ; projet supprimé recréé en silence.
- **Q06** (P2) — Acompte puis solde impossible en un clic ; facture de mensuel liée à la vente hors échéance.
- **Q07** (P3) — Montant de la fiche, montant du revenu et vocabulaire divergents.
- **Q08** (P2) — Pas de dépôt client sur une demande d'onboarding.
- **Q09** (P3) — Chrono oublié > 7 jours impossible à arrêter.
- **Q10** (P2) — Script de suppression des données [TEST] incomplet (échoue avec une vente).
- **Q11** (P3) — La carte Ventes peut faire reculer un projet en cours.

### D.3 Confort
- **K01** Deux écrans du jour, double redirection, Focus sans menu.
- **K02** Quatre formulaires de revenus/factures.
- **K03** Menu à 11 entrées ; mobile qui masque des entrées.
- **K04** Agenda et Liste séparés ; détail par lien seulement depuis Liste.
- **K05** Libellés trompeurs (deux « Modèles », « Gérer les pipelines », Gmail « envois programmés », doc de clôture périmée).
- **K06** Doublons sur réponses/résultats de campagne, Focus en deux appels, création de tâche non protégée.
- **K07** Saisie perdue sur doublon ; formulaire « Nouvelle fiche » complet d'emblée.
- **K08** Palette ⌘K limitée aux fiches.
- **K09** Pas de temps ni d'appel par projet.
- **K10** « Documents validés » à cocher malgré un contrat ; préparation non relancée ; deux mécanismes de préparation.
- **K11** Aperçu du portail sans état de visibilité ; limite de connexion globale ; dépôt supprimé disparaît de la fiche ; partage des slides non atomique.
- **K12** Performance (poids Finance et Modèles, rechargements de campagne, écriture à la lecture Finance, index).
- **K13** 32 exports jamais utilisés, branches mortes.
- **K14** Petits points d'intégration (état MCP, personne absente de l'historique email, portées OAuth MCP, rattachement Fireflies quotidien, redirection Gmail selon l'URL d'appel, ancienneté du webhook, Ventes non rafraîchi après Finance, arrondis TTC/HT).

## E. Simplifications
E1 page « Aujourd'hui » ; E2 formulaire unique de revenu ; E3 menu allégé ; E4 Agenda + Liste ; E5 liens croisés
vente ↔ revenu ↔ projet ; E6 chargements à la demande ; E7 une seule source d'état de préparation ; E8 code mort ;
E9 « Gérer les pipelines ». À ne pas retirer sans données d'usage : Focus, Réponses, boîte à idées, Rentabilité, simulation.

## F. Plan proposé
Lot 0 (C15, Q10, K05) · Lot 1 (C01, C03, C10, Q11) · Lot 2 (C02) · Lot 3 (C04, C05, Q06, E2) · Lot 4 (Q01, E1, Q04) ·
Lot 5 (C07, C08, Q02, C09) · Lot 6 (C06, Q08, K11) · Lot 7 (E3, E4, K06, K07, K08, E9) · Lot 8 (E6, K12) ·
Plus tard (Q03, Q05, K09, C13, file d'envoi). Prérequis : base de test reliée à l'application.

## G. Décisions (tranchées par l'utilisateur le 11/11/2026, voir le suivi)
Ventes verrouillées ; effets proposés et confirmés ; fusion de deux ventes bloquée ; formulaire commun ; « Aujourd'hui »
point d'entrée avec tâches de projet ; réservation suspendue si l'agenda est invérifiable ; invités notifiés ; partage
explicite ; mensuel « / mois » ; client qui revient = nouvelle vente et nouvelle mission ; temps et appels par projet ;
réception Gmail et moteur de rappels inclus ; Mail et Appels au premier niveau ; Focus, Réponses, idées, Rentabilité et
simulation conservés ; état de préparation de l'onboarding à source commune.
