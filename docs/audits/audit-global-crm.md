# Audit global de Cely Growth — connexions, cohérence et simplicité

- **Version auditée** : `origin/main` au commit `d5cb064` (fusion de la PR #16 « Projets depuis Gagné », donc incluse).
- **Date** : 11 novembre 2026.
- **Nature** : lecture du code et des 38 migrations, exécution de tests sur une base de test en mémoire (PGlite, qui applique les vraies migrations), build de production. **Aucune donnée réelle n'a été lue ni modifiée.** Aucun envoi, partage ou appel vers Google, Gmail, Fireflies ou Claude n'a eu lieu.
- **Méthode** : six agents ont travaillé en parallèle, chacun sur un périmètre (données, commercial, projets et portail, finance, intégrations, ergonomie et performance). J'ai ensuite relancé leurs tests, recontrôlé dans le code les constats les plus lourds, fusionné les doublons et tranché les contradictions (voir l'annexe 2).

### Niveaux de preuve utilisés

| Mention | Signification |
|---|---|
| **Vérifié (test)** | Rejoué sur la base de test avec les vraies migrations : un test du dépôt, ou un test temporaire écrit hors du dépôt pour cet audit |
| **Lu (code)** | Certain à la lecture du code, mais pas exécuté |
| **Hypothèse** | Déduction plausible, à confirmer |
| **Config externe** | Dépend de réglages Vercel, Google, Fireflies ou Claude que je ne vois pas |
| **Indéterminé** | Impossible à vérifier faute d'accès (voir A.5) |

---

## A. Synthèse

### A.1 Ce qui fonctionne bien

- **Une seule fiche par entreprise**, du prospect au client. Rien n'est copié quand la fiche passe d'un module à l'autre.
- **Les règles importantes sont en base**, appelées de la même façon par l'interface et par Claude : anti-doublons, idempotence (un double clic ne crée pas deux fois la même chose), verrous.
- **Ce qui a été vérifié** :
  - types et lint sans erreur ;
  - **579 tests sur 579** réussis ;
  - build de production réussi ;
  - les 26 tests temporaires des agents, que j'ai relancés et qui passent tous.
- **Le passage à Gagné** crée en une seule fois la vente, le revenu et le projet, sans ressaisir le client et sans doublon si on réessaie. Vérifié (test).
- **L'encaissement** se fait en un clic par échéance (facture et règlement ensemble, paiement partiel compris). Le pipeline n'entre jamais dans les prévisions, donc il n'y a pas de double comptage avec le signé.
- **Le cloisonnement du portail client est solide** : un autre client, une session révoquée ou une clé absente n'obtiennent rien, et aucune note interne ne sort. Vérifié (test, 4 sur 4).
- **Intégrations** :
  - jetons Gmail et Google Agenda chiffrés ;
  - signatures Fireflies vérifiées ;
  - pas de doublon d'email, d'événement ou d'appel ;
  - rattachement Fireflies prudent : jamais déduit d'un domaine grand public.
- **Claude (MCP)** passe par les mêmes fonctions que l'interface, et la base lui refuse les actions sensibles (Lu, code et tests unitaires).

### A.2 Principales ruptures entre modules

1. **Une vente gagnée peut être rouverte sans que vous le voyiez.** Il suffit de changer l'étape de la fiche, de choisir « Hors pipeline », d'un déplacement fait par Claude ou d'un « Intéressé » en campagne. Le client sort alors de Ventes, et son revenu mensuel reste compté dans Finance (C01).
2. **La fusion de deux fiches oublie les projets, les rendez-vous et parfois la vente.** Le projet du client reste sur une fiche archivée, que plus aucun écran ne montre (C02).
3. **Perdre une vente après l'avoir rouverte laisse son projet ouvert et son revenu dans les prévisions**, sans aucun signal (C03).
4. **Les tâches de projet n'apparaissent pas dans À faire** (Q01).
5. **Finance peut afficher des chiffres faux** : « Encaissé » dès le premier mois payé, revenus terminés encore comptés, facture rattachée au revenu d'un autre client (C04, C05).
6. **Rendez-vous** :
   - les écarts avec Google Agenda ne sont jamais rattrapés automatiquement (C07) ;
   - l'invité ne reçoit aucune confirmation ni aucun rappel (Q02) ;
   - si l'agenda est déconnecté, la page publique accepte des réservations sans vérifier votre agenda (C08).
7. **Les emails reçus n'entrent pas dans le CRM** : les réponses sont à recopier à la main (Q03).

### A.3 Sources de complexité

- **Deux écrans pour la même liste du jour** : « À faire » et « Prospection › Aujourd'hui ». S'y ajoutent Focus et « Réponses à traiter ».
- **Quatre formulaires créent ou modifient les mêmes revenus**, avec des règles différentes. C'est la cause directe de deux défauts de données.
- **11 entrées dans le menu principal.** Sur téléphone, certaines sont cachées hors de l'écran.
- **Deux systèmes de tâches** qui ne se voient pas l'un l'autre.
- **Le même état est décrit trois ou quatre fois** : statut de la fiche, état de la vente, statut du projet, statut du revenu. Seuls les deux premiers sont synchronisés.

### A.4 Les cinq actions qui auraient le plus d'impact

| # | Action | Ce que vous gagnez | Effort |
|---|---|---|---|
| 1 | **Verrouiller les ventes clôturées** : on ne rouvre que par le bouton « Rouvrir ». Au passage à Perdu, le CRM propose d'archiver le projet et d'arrêter le revenu. | Ventes et Finance restent justes | S à M |
| 2 | **Compléter la fusion de fiches** : projets, rendez-vous et ventes suivent la fiche conservée. | Aucun client « perdu » après le nettoyage des doublons | M |
| 3 | **Une seule page « Aujourd'hui »** : relances, tâches CRM, **tâches de projet** et réponses à traiter. | Un seul endroit à consulter le matin | M |
| 4 | **Fiabiliser Finance** : badge « Encaissé » juste, contrôle du client sur les factures, revenus terminés exclus, acompte puis solde en un clic. | Des chiffres auxquels vous pouvez vous fier | S à M |
| 5 | **Fiabiliser Rendez-vous** : rattrapage automatique avec Google, invitation envoyée à l'invité, réservation suspendue si l'agenda est déconnecté. | Moins d'oublis et pas de double réservation | S à M |

### A.5 Accès manquants et vérifications impossibles

- **Connecteur Claude `cely-crm` de cette machine** : il pointe vers `localhost` et échoue (ECONNREFUSED). C'est un **accès manquant**, pas une fonction absente. Aucun outil MCP n'a été utilisé en réel.
- **Aucune base de test reliée à l'application.** `.env.local` pointe vers la production, donc l'application n'a pas été lancée et **aucun parcours n'a été vérifié dans un navigateur**. Tout ce qui est « vérifié » l'est au niveau de la base de test et des tests automatisés.
- **Google Agenda, Meet, Gmail, Fireflies et les routines Claude** (diagnostic, onboarding) : aucun appel réel ; les tests les simulent. La connexion Google Agenda en production n'est toujours pas confirmée de bout en bout, et le parcours du diagnostic avec le vrai Claude reste à prouver.
- **Vercel** : je ne vois ni les variables, ni le plan (nombre de tâches planifiées autorisées), ni les journaux.
- **Production** : je ne sais pas quelles migrations y ont été appliquées, ni comment (éditeur SQL ou CLI). C'est nécessaire pour trancher C15.
- **Stockage Supabase hébergé** : ses règles d'accès n'ont pas été vérifiées (C13).
- **Aucune donnée d'usage** : les retraits proposés en E sont des **candidats**, jamais des certitudes.
- **Temps de réponse réels** : non mesurés. Seuls le poids du code et le nombre de requêtes l'ont été.
- **Outil `gh`** absent de la machine : la fusion de la PR #16 a été vérifiée par l'historique Git.

---

## B. Carte de l'application

### B.1 Schéma

```
                    ┌──────────── Prospection ────────────┐
 Import CSV ──┐     │ campagnes · séquences · Focus       │
 Claude (MCP)─┼──►  │ réponses à traiter (saisie manuelle)│
 Réservation ─┘     └──────────────┬──────────────────────┘
 publique (/rdv)                   │ « Intéressé » + étape
                                   ▼
        personnes ◄──── FICHE (companies) ────► historique (interactions)
        tâches CRM ◄─┘   deal_status · étape        ▲   ▲   ▲
                         montant estimé             │   │   │
                               │ « Gagné »         Gmail│  Fireflies
                               ▼ (sale_confirm)   (envoi)│  (appels)
                     ┌──── VENTE (sales) ────┐      rendez-vous
                     ▼                       ▼     (appt_bookings)
            REVENU (finance_missions)   PROJET (projects) ──► PORTAIL client
                     │                       │  tâches de projet, fichiers partagés,
            échéances (calculées)            │  points, idées, onboarding
                     ▼                       │
            FACTURE ──► RÈGLEMENT            └─ préparation : proposition,
                     │                          diagnostic, résumés Fireflies
                     ▼                          (+ analyse Claude si configurée)
        Finance : encaissé, prévisions, URSSAF

   Temps (time_entries) ──► fiche uniquement (pas de projet)
```

### B.2 Données de référence

| Donnée | Table | Source de vérité pour | Reliée à |
|---|---|---|---|
| Fiche | `companies` | identité, étape, issue commerciale (`deal_status`), montant estimé | tout le reste |
| Personne | `people` | contacts, email normalisé (sert au rattachement) | fiche |
| Historique | `interactions` | journal daté de la fiche | fiche, personne |
| Tâche CRM | `tasks` | À faire, prochaine action | fiche |
| Vente | `sales` (une par fiche) | lien vente → revenu → projet, documents validés, état de préparation | fiche, revenu, projet |
| Revenu | `finance_missions` | montant prévu et échéancier | fiche |
| Facture et règlement | `finance_invoices`, `finance_payments` | facturé et encaissé | fiche, revenu |
| Projet | `projects` | statut, publication sur le portail | fiche (pas de lien vers la vente côté projet) |
| Tâche de projet | `project_tasks` | plan de travail, visibilité client | projet |
| Fichier | `company_files` (+ `project_files`, simple référence) | contenu stocké une fois, partagé par référence | fiche, projet |
| Rendez-vous | `appt_bookings` | agenda, événement Google | fiche, personne (par email) |
| Appel | `fireflies_calls` | transcription, résumé | fiche, personne, rendez-vous |
| Email | `mail_messages` | envois Gmail | fiche, personne |
| Temps | `time_entries` | temps passé | fiche seulement |

**Point d'attention** : l'avancement d'un client est décrit par quatre indicateurs, à savoir le statut de la fiche, l'état de la vente, le statut du projet et le statut du revenu. Seuls les deux premiers sont synchronisés automatiquement. Les ruptures C01 et C03 viennent de là.

---

## C. Parcours intermodules

| # | Parcours | Statut | Ce qui marche | Étape qui pose problème |
|---|---|---|---|---|
| 1 | Prospect → campagne → échange → pipeline | **Partiel** | Création sans doublon (manuelle, import, Claude), inscription, étapes de séquence, entrée en pipeline sans recopier la fiche, arrêt des relances. Vérifié (test). | Les réponses sont saisies à la main (Q03). Une réponse enregistrée deux fois crée un doublon (K06). « RDV obtenu » et « Intéressé sans pipeline » font disparaître la fiche de toutes les files (Q04). |
| 2 | Gagné → Ventes → suivi après-vente → projet | **Partiel, avec un cas cassé** | Gagné depuis la fiche, le Kanban ou Ventes : vente, revenu et projet créés en une fois ; préparation reprise après un échec. Vérifié (test). | Réouverture silencieuse par un changement d'étape (C01, cassé). Un client qui revient avec un projet terminé n'entre pas dans le suivi (Q05). La carte Ventes peut faire reculer un projet en cours (Q11). |
| 3 | Gagné → revenu → facture → règlement | **Partiel** | Revenu créé avec la vente ; un clic « Encaisser » par échéance ; paiements partiels plafonnés. Vérifié (test). | « Encaissé » affiché trop tôt (C05). Facture rattachée au revenu d'un autre client (C04). Une facture saisie depuis Finance › Clients compte deux fois une échéance dans les prévisions (C04). Acompte puis solde impossible en un clic (Q06). |
| 4 | Proposition + diagnostic + Fireflies → préparation de l'onboarding | **Partiel ; analyse non vérifiée en réel** | Préparation en base : choix de la proposition, du dernier diagnostic et des 5 derniers résumés d'appels, avec les éléments manquants listés. Vérifié (test, 10 tests). | Le CRM ne lit pas le contenu des propositions (PDF ou Word) : seuls le nom et la catégorie comptent. L'analyse par Claude dépend d'une routine configurée (Config externe, Indéterminé). Ajouter une pièce ne relance pas la préparation (K10). |
| 5 | Réservation → Google Agenda / Meet → fiche → projet | **Partiel** | Réservation sans doublon, événement Google et Meet, rattachement à la fiche par email ou création de la fiche. Vérifié (test, Google simulé). | L'invité n'est prévenu par personne (Q02). Pas de rattrapage automatique avec Google (C07). Agenda déconnecté : double réservation possible (C08). Le lien avec le projet se fait toujours à la main. Connexion réelle non confirmée. |
| 6 | Appel Fireflies → bonne fiche → historique → projet | **Vérifié jusqu'à l'historique ; projet absent** | Webhook signé, file d'import avec reprises, rattachement par rendez-vous puis par email, une seule entrée d'historique par appel. Vérifié (test, Fireflies simulé). | Un appel ne peut pas être rattaché à un projet (K09). Si un contact est ajouté après l'appel, celui-ci reste « À rattacher » jusqu'au lendemain (K14). |
| 7 | Email reçu ou envoyé → personne → fiche → conversation | **Partiel (envoi seulement)** | Envoi depuis une fiche, état « incertain » géré, entrée dans l'historique. Vérifié (test). | Réception inexistante (Q03). La personne manque parfois dans l'historique (K14). Aucun envoi automatique (Q02). |
| 8 | Tâche créée dans une section → À faire → validation | **Cassé pour les tâches de projet** | Tâches CRM : fiche et À faire partagent le même état. | Les tâches de projet sont absentes d'À faire, du compteur et de la prochaine action (Q01). |
| 9 | Fichier CRM → projet → partage explicite dans le portail | **Partiel** | Partage par référence, cloisonnement vérifié, lien de téléchargement limité à 60 s. Vérifié (test). | « Partager avec le projet » rend le document visible du client sans confirmation (C06). Le client ne peut pas déposer un fichier sur une demande d'onboarding (Q08). La fusion casse le parcours (C02). |
| 10 | Chrono → client ou projet → total | **Partiel** | Un seul chrono à la fois, heure du serveur, total par client. Vérifié (test). | Pas de temps par projet (K09). Un chrono oublié plus de 7 jours ne peut plus être arrêté (Q09). |
| 11 | Modification depuis Claude (MCP) → mêmes règles | **Vérifié dans le code ; non vérifié en réel** | Mêmes services et fonctions en base, anti-doublons, idempotence, refus des actions sensibles. Lu (code) et tests unitaires. | Un déplacement par Claude rouvre une vente gagnée sans le signaler (C01). Connecteur inaccessible depuis cette machine. |
| 12 | Déconnexion d'un connecteur → effet compréhensible | **Partiel** | Gmail et Claude : effets justes et expliqués. | Agenda : le texte ne dit ni que les reports deviennent impossibles, ni que la double réservation devient possible, et affiche « révoqué » même en cas d'échec (C08). Le texte Gmail promet des envois programmés qui n'existent pas (K05). Fireflies n'a pas de bouton de déconnexion. |

**Rechargement, report, annulation, répétition** :
- les doubles clics et les nouvelles tentatives sont bien gérés sur la création de fiche, l'import, la vente, le revenu, l'encaissement, la réservation, l'envoi d'email et l'import Fireflies ;
- les exceptions sont les réponses et résultats de campagne, la création de tâches et les tâches issues d'un récapitulatif (K06) ;
- la clé d'idempotence du revenu d'une vente peut bloquer définitivement une vente (C10).

---

## D. Constats détaillés

Chaque constat a un identifiant stable : **C** pour un risque sur les données ou les accès, **Q** pour un blocage quotidien, **K** pour une amélioration de confort. Les identifiants des agents (A1-xx à A6-xx) sont indiqués pour la traçabilité. Effort : XS < 1 h, S ≈ une demi-journée, M ≈ 1 à 2 jours, L > 3 jours. Ces estimations sont incertaines tant que l'application n'a pas été relancée sur une base de test.

### D.1 Risques sur les données ou les accès

#### C01 — Une vente gagnée est rouverte sans confirmation par un simple changement d'étape — priorité 1
- **Symptôme**. Le sélecteur d'étape reste actif sur une fiche gagnée. Plusieurs actions rouvrent la vente sans passer par la fenêtre « Rouvrir », qui avertit du projet et du revenu liés :
  - choisir une étape ;
  - choisir « Hors pipeline » ;
  - un déplacement demandé à Claude (`move_company`) ;
  - un « Intéressé + étape » dans une campagne.

  Le client sort alors de Ventes et son revenu mensuel reste actif. Après « Hors pipeline », il devient même impossible de le marquer à nouveau gagné.
- **Parcours** : 1, 2, 3, 11.
- **Cause constatée** : `move_company` force l'état « ouvert » (`supabase/migrations/20261029000300_functions.sql:769`). Le sélecteur n'est jamais désactivé (`src/components/record-header.tsx:96-104`, `src/components/record-deal.tsx:32-39`, `src/components/use-move-company.ts:14-44`).
- **Preuve** : Vérifié (test, scénarios A, B et E) et recontrôlé dans le code.
- **Impact** : un client signé disparaît du suivi sans que vous le voyiez, et les prévisions restent gonflées.
- **Correction** : la base refuse de déplacer une fiche clôturée, sauf réouverture explicite. L'interface désactive alors le sélecteur et renvoie vers « Rouvrir ». Claude reçoit un message clair.
- **Effort** : S. **Dépendances** : le test existant « déplacer une fiche clôturée la rouvre » (`tests/db/cloture.test.ts`) et `docs/cloture-opportunite.md` sont à adapter. Pas de migration de données. A1-03 (partie Kanban), A2-01, A2-02, A2-05.

#### C02 — La fusion de fiches oublie les projets, les rendez-vous et parfois la vente — priorité 1
- **Symptôme** : après une fusion, les projets et les rendez-vous restent sur la fiche absorbée, qui est archivée et invisible. Si les deux fiches avaient une vente, celle de la fiche absorbée disparaît de Ventes, alors que son revenu a bien été déplacé. Si la fiche absorbée était gagnée, sa vente peut se retrouver « gagnée » sur une fiche restée ouverte. Le projet ne peut plus recevoir de membres, ses déplacements de fichiers sont refusés, et les dépôts du client partent sur la fiche archivée.
- **Parcours** : 2, 5, 9.
- **Cause constatée** : `merge_companies` (`functions.sql:924-1032`) et ses déclencheurs déplacent la finance, les emails, les fichiers, Fireflies, le diagnostic et le temps, mais **rien** pour `projects` et `appt_bookings`. La vente n'est déplacée que si la fiche conservée n'en a pas (`20261113000100_ventes.sql:48-61`).
- **Preuve** : Vérifié (test, deux agents séparément) pour les projets et les ventes ; Lu (code) pour les rendez-vous.
- **Impact** : nettoyer les doublons peut « perdre » un client en cours de projet.
- **Correction** :
  - déplacer projets et rendez-vous avec la fiche ;
  - refuser la fusion de deux fiches qui ont chacune une vente, ou les traiter explicitement ;
  - avertir dans l'écran de fusion ;
  - écrire une migration de rattrapage pour les fiches déjà fusionnées.
- **Effort** : M. **Dépendances** : migration additive et rattrapage. Il faut vérifier en production si des fusions ont déjà eu lieu (lecture seule). A1-01, A2-03, A2-04, A3-03.

#### C03 — Perdre une vente rouverte laisse son projet ouvert et son revenu dans les prévisions — priorité 1
- **Symptôme** : quand une vente est gagnée, puis rouverte, puis perdue, le projet reste « en cours » ou « à préparer », et le portail reste ouvert si le projet est publié. Le revenu reste actif et compté dans les prévisions, sans aucun signal dans Finance ni dans Projets. Un revenu ponctuel ne peut même pas être arrêté à la réouverture. Si la vente est regagnée, un revenu arrêté le reste sans que rien ne le signale.
- **Parcours** : 2, 3.
- **Cause** : la réouverture et la perte ne touchent ni au projet ni au revenu (`ventes.sql:65-79`). L'arrêt du revenu et la réouverture sont deux appels séparés (`src/components/deal-closing.tsx:140-143, 188`).
- **Preuve** : Vérifié (test, trois agents).
- **Impact** : prévisions fausses, projets fantômes, et un ex-prospect qui garde accès au portail.
- **Correction** : au passage à Perdu, proposer d'archiver le projet et d'arrêter le revenu, sur votre confirmation et jamais d'office. Afficher un badge « vente rouverte ou perdue » dans Revenus et dans Projets.
- **Effort** : M. **Dépendances** : C01 (même fenêtre de confirmation). A1-03, A2-13, A4-09.

#### C04 — Factures et revenus peuvent pointer vers le mauvais client, et une échéance peut être comptée deux fois — priorité 1
- **Symptômes** :
  - « Modifier la mission » (Finance › Clients) permet de changer le client d'un revenu lié à une vente ;
  - la modification d'une facture accepte le revenu d'un autre client, et **délie** la facture de son revenu si ce champ n'est pas renvoyé ;
  - une facture saisie depuis Finance › Clients se rattache à la plus ancienne échéance, même déjà facturée, ce qui compte cette échéance deux fois dans les prévisions.
- **Parcours** : 3.
- **Cause constatée** :
  - `finance_save_mission` et `finance_update_invoice` ne contrôlent pas le client (`20261101000100_finance.sql:348-354` et `:432-437`), alors que `finance_record_invoice`, lui, le contrôle ;
  - `src/app/(app)/finance/clients/clients-view.tsx:162` n'envoie pas la liste des factures, et `src/components/finance/forms.tsx:127,149` retombe sur une liste vide.
- **Preuve** : Vérifié (test) pour les deux premiers ; Lu (code), et recontrôlé, pour le troisième.
- **Impact** : totaux par client faux et prévisions surévaluées.
- **Correction** : contrôle du client en base (même fiche pour la facture et le revenu) ; choix du client masqué en modification ; liste des factures transmise (une ligne) ; refus d'une seconde facture sur une échéance déjà couverte.
- **Effort** : S. **Dépendances** : contrôler en lecture seule si des incohérences existent déjà en production. A1-05, A4-02, A4-04.

#### C05 — Indicateurs Finance trompeurs — priorité 2
- **Symptômes** :
  - **(a)** Ventes affiche « Encaissé » dès la première facture payée : un mois d'un mensuel, ou un acompte de 1 000 € sur 3 000 € ;
  - **(b)** le revenu mensuel récurrent et les « clients actifs » comptent les revenus dont la date de fin est passée ;
  - **(c)** annuler un paiement déjà remboursé donne un encaissé négatif ;
  - **(d)** un avoir fait remonter le « reste à facturer » dans les prévisions.
- **Cause** :
  - (a) `ventes.sql:330-335` ;
  - (b) `src/lib/finance/calc.ts:176-186` ;
  - (c) `finance.sql:521-531` ;
  - (d) `src/lib/finance/revenues.ts:74-77`.
- **Preuve** : Vérifié (test) pour (a), (b) et (c) ; Lu (code) pour (d).
- **Impact** : vous pensez être payé ou avoir un revenu récurrent qui n'existe plus.
- **Correction** : (a) « Encaissé » seulement quand tout le montant prévu est facturé et réglé, sinon « Partiellement encaissé » ou « En cours » ; (b) une condition sur la date de fin ; (c) un refus en base ; (d) proposer de réduire aussi le revenu lors d'un avoir.
- **Effort** : S. A1-06, A4-01, A4-07, A4-08, A4-10.

#### C06 — Partage avec le client sans confirmation — priorité 2
- **Symptômes** :
  - « Partager avec le projet » place le document à la racine, donc visible et téléchargeable par le client si le projet est publié, sans confirmation ni choix de dossier. Claude, lui, doit confirmer ;
  - les commentaires d'une tâche interne deviennent visibles dès que la tâche est rendue visible ou attribuée au client ;
  - une demande d'onboarding partagée reprend le libellé interne comme titre visible du client ;
  - une tâche issue d'un récapitulatif encore en brouillon est visible tout de suite.
- **Parcours** : 9.
- **Cause** :
  - `src/components/projects/admin-files.tsx:55` et `src/lib/projects/service.ts:207-208` ;
  - `20261107000300_projets_taches.sql:131-137` ;
  - `20261114000100_projet_onboarding.sql:497-498` ;
  - `src/lib/projects/service.ts:162-177`.
- **Preuve** : Lu (code). Le test de cloisonnement passe, mais il ne couvre pas ces cas.
- **Impact** : un contrat, un diagnostic ou une note interne peut être montré au client par erreur.
- **Correction** : confirmation « N documents deviendront visibles du client » avec choix du dossier ; avertissement quand la tâche a des commentaires ; titre modifiable marqué « visible du client » ; tâche interne tant que le récapitulatif n'est pas publié.
- **Effort** : S à M. A3-06, A3-07, A3-08, A3-09.

#### C07 — Les écarts avec Google Agenda ne sont jamais rattrapés automatiquement — priorité 2
- **Symptôme** : une annulation ou un report non répercuté, ou un déplacement fait directement dans Google, ne sont rattrapés qu'au prochain clic manuel ou à la prochaine réservation. Pourtant, la documentation promet une tâche planifiée.
- **Parcours** : 5, 12.
- **Cause constatée** :
  - `vercel.json` ne planifie que Fireflies ;
  - la route prévue `/api/rendez-vous/reconcile` est absente de la liste des routes publiques du proxy (`src/proxy.ts:9`). Une tâche planifiée sans session reçoit donc « 401 » (`src/proxy.ts:30-32`) avant même le contrôle de son secret ;
  - la reprise lancée après une réservation n'est pas attendue (`src/lib/appointments/server.ts:287-294`) et peut être interrompue par Vercel.
- **Preuve** : Lu (code), recontrôlé. Comportement Vercel : Config externe.
- **Impact** : agenda faux (créneau bloqué à tort, ou rendez-vous annulé encore présent).
- **Correction** : ouvrir la route à la tâche planifiée (elle vérifie déjà son secret) ; ajouter la tâche dans `vercel.json`, ou la greffer sur la tâche Fireflies si le plan Vercel limite le nombre de tâches ; attendre proprement la reprise.
- **Effort** : S. **Dépendances** : plan Vercel et `CRON_SECRET`. A5-01.

#### C08 — Agenda déconnecté : double réservation possible, reports bloqués, message incomplet — priorité 2
- **Symptôme** : sans agenda connecté, la page publique propose des créneaux sans vérifier vos événements personnels. Le report d'un rendez-vous existant est refusé à l'invité, et une annulation laisse l'événement dans Google. Le texte de déconnexion ne le dit pas et affiche « révoqué » même quand la révocation a échoué.
- **Cause** : `src/lib/appointments/server.ts:83, 381-385, 428` ; `src/lib/connectors/status.ts:128,133` ; `src/lib/appointments/google.ts:102-105` ; `src/app/connecteurs-actions.ts:106-108`.
- **Preuve** : Lu (code).
- **Correction** :
  - proposer de suspendre la page publique à la déconnexion ;
  - accepter le report en le marquant « à répercuter » ;
  - compléter le texte ;
  - remonter l'échec de révocation, comme le fait déjà Gmail.
- **Effort** : M. A5-04, A5-06.

#### C09 — La réservation publique n'a aucune protection contre les abus — priorité 3
- **Symptôme** : n'importe qui peut réserver avec l'adresse d'un de vos contacts. Le rendez-vous et une note sont alors ajoutés à sa fiche, et une fiche est créée si l'entreprise est inconnue. Il n'y a ni limite de débit, ni piège anti-robot, ni vérification de l'email.
- **Cause** : `src/app/api/rdv/book/route.ts` ; `20261105120000_rendez_vous.sql:612-622, 662-668`.
- **Preuve** : Lu (code) ; aucun essai n'a été fait.
- **Impact** : pollution de fiches et créneaux bloqués. Le risque est limité par les créneaux disponibles et la limite quotidienne.
- **Correction** : limite par email et par adresse IP, champ piège, mention « à confirmer » sur les fiches anciennes.
- **Effort** : M. A5-08.

#### C10 — Supprimer le revenu d'une vente bloque définitivement « Marquer comme gagné » — priorité 1
- **Symptôme** : si le revenu créé avec une vente est supprimé, toute nouvelle confirmation de cette vente échoue par une erreur technique, y compris par « Lier une facture ». La vente ne peut plus être complétée.
- **Cause constatée** : le revenu est créé avec une clé fixe (`'sale-revenue:' || id`, `ventes.sql:170-172, 190-192`), qui renvoie l'identifiant du revenu supprimé.
- **Preuve** : Vérifié (test).
- **Correction** : vérifier que le revenu existe encore, sinon en créer un nouveau. Ou bien interdire la suppression d'un revenu lié à une vente et proposer « Arrêter » à la place.
- **Effort** : S. A1-02.

#### C11 — Les clés anti-doublon n'ont pas de portée — priorité 3
- **Symptôme** : une même clé réutilisée par deux actions différentes renvoie le résultat de la première, sans rien écrire et sans erreur. Par exemple, une facture n'est pas créée.
- **Cause** : la fonction `idem_get` ne filtre pas sur `scope` (`functions.sql:24-35`).
- **Preuve** : Vérifié (test). La probabilité est faible, car les clés sont aléatoires, mais l'échec est silencieux.
- **Correction** : filtrer par portée.
- **Effort** : XS. A1-04.

#### C12 — Un seul secret serveur pour Rendez-vous, Google, Fireflies et le portail — priorité 3
- **Symptôme** : changer ou perdre `APPOINTMENTS_SECRET` casse en même temps :
  - le jeton Google ;
  - les liens privés de rendez-vous ;
  - l'import Fireflies ;
  - les codes du portail.
- **Cause** : `src/lib/appointments/secrets.ts:21-79`, utilisé par `src/app/api/fireflies/webhook/route.ts` et `src/lib/fireflies/worker.ts`.
- **Preuve** : Lu (code).
- **Correction** : documenter ce secret comme « secret serveur global », avec une procédure de rotation. Le renommage peut attendre.
- **Effort** : S. A5-05.

#### C13 — Téléchargements du portail : autorisation liée au nom du fichier — priorité 3, à vérifier
- **Symptôme** : pendant 60 secondes, l'autorisation de lecture porte sur le nom du fichier et non sur la session du client.
- **Atténuation** : la clé reste côté serveur.
- **Cause** : `20261107000400_projets_fichiers.sql:99-116`.
- **Preuve** : **Hypothèse**, non vérifiée sur Supabase hébergé.
- **Correction** : liens signés côté serveur.
- **Effort** : M. A3-10.

#### C14 — Règles de suppression inégales — priorité 3
- **Symptômes** :
  - supprimer une fiche efface en silence son diagnostic et son temps passé (`cascade`), alors que tout le reste bloque la suppression ;
  - Claude peut supprimer des emails, du temps et des tâches de projet, mais pas des fiches ni des fichiers CRM ;
  - toute nouvelle fonction SQL reste exécutable par tous si sa migration oublie de la restreindre.
- **Cause** : `20261109000100_diagnostic.sql:73`, `20261110000100_temps.sql:10` et les politiques `owner_all`.
- **Preuve** : Vérifié (introspection en test).
- **Correction** : une règle unique, appliquée partout, et un test qui liste les fonctions accessibles sans connexion.
- **Effort** : S. A1-11, A1-14.

#### C15 — Migrations : un numéro de version en double et des dates dans le futur — priorité 2 (avant tout nouveau déploiement)
- **Symptôme** : `20261108000100_finance_revenus.sql` et `20261108000100_fireflies.sql` portent le même numéro, ce qui ferait échouer `supabase db push`. Trois migrations sont datées des 12 au 14 novembre. Enfin, une migration modifie 13 fonctions par remplacement de texte, ce qui est fragile si l'une d'elles est redéfinie (`20261110000200_mcp_espaces_client.sql:21-46`).
- **Preuve** : Lu (code), recontrôlé. Effet en production : **Indéterminé**, car je ne sais pas comment la production a été migrée.
- **Correction** : renommer la migration Fireflies **seulement** si la production n'a pas été migrée par la CLI ; dater les prochaines migrations après le 14 novembre.
- **Effort** : XS à S. A1-12, A1-13.

### D.2 Blocages quotidiens

#### Q01 — Les tâches de projet n'apparaissent pas dans À faire — priorité 1
- **Symptôme** : une tâche de projet qui vous est attribuée, avec une échéance, n'apparaît ni dans À faire, ni dans le compteur du menu, ni dans la « prochaine action » de la fiche.
- **Parcours** : 8.
- **Cause** : la vue `todo_items` ne lit que les tâches CRM et les relances (`20261030000100_prospection_v2.sql:929-939`).
- **Preuve** : Lu (code), recontrôlé, confirmé par trois agents.
- **Correction** : ajouter à cette vue les tâches de projet qui vous sont attribuées, avec un lien vers le projet. Les deux tables restent séparées.
- **Effort** : S à M. A1-08, A3-01.

#### Q02 — Aucun email automatique : l'invité n'est prévenu par personne — priorité 2
- **Symptôme** : lors d'une réservation, d'un report ou d'une annulation, l'invité ne reçoit rien, ni du CRM ni de Google. Les rappels sont calculés mais jamais envoyés.
- **Cause** : aucun appelant des fonctions de rappel (`src/lib/appointments/mail-adapter.ts:69-105`) ; `sendUpdates=none` (`src/lib/appointments/google.ts:190,223`). C'est conforme à l'état connu : Mail phase 1 seulement.
- **Preuve** : Lu (code).
- **Correction** :
  - **court terme** : laisser Google envoyer l'invitation (`sendUpdates=all`). Effet secondaire : Google affiche alors votre adresse d'organisateur ;
  - **moyen terme** : file d'envoi (phase 3 du Mail).
- **Effort** : S (court terme), L (file d'envoi). A5-02.

#### Q03 — Les emails reçus n'entrent pas dans le CRM — priorité 2
- **Symptôme** : les réponses de prospects sont à recopier sur la fiche, et les relances ne se mettent pas en pause d'elles-mêmes.
- **Cause** : l'autorisation Gmail se limite à l'envoi (`src/lib/mail/google.ts:9,21`) ; la phase 2 (réception) n'a pas été construite.
- **Preuve** : Lu (code).
- **Correction** : lecture Gmail planifiée et rattachement par email, comme les rendez-vous.
- **Effort** : L. **Dépendances** : nouvelle autorisation Google (lecture), à valider par vous. A5-03.

#### Q04 — « RDV obtenu » et « Intéressé sans pipeline » : la fiche disparaît de toutes les files — priorité 2
- **Symptôme** : la fiche sort de « Réponses à traiter » sans entrer dans un pipeline ni recevoir de tâche. Elle n'est plus dans aucune liste.
- **Cause** : `src/app/(app)/prospection/reponses/page.tsx:11-12` ; `prospection_v2.sql:836-838`.
- **Preuve** : Lu (code).
- **Correction** : pour ces deux résultats, demander l'étape ou créer une tâche de suivi.
- **Effort** : S. A2-07.

#### Q05 — Un client qui revient n'a pas de parcours, et un projet supprimé est recréé en silence — priorité 3
- **Symptôme** : il n'y a qu'une vente par fiche. Regagner un client dont le projet est terminé réutilise ce projet : la vente passe directement à « terminé » et n'entre pas dans le suivi. Par ailleurs, supprimer un projet puis reconfirmer la vente en crée un nouveau sans prévenir.
- **Cause** : `ventes.sql:202-221, 338` ; `ventes.sql:26`.
- **Preuve** : Vérifié (test).
- **Correction** :
  - **court terme** : proposer « nouveau projet » quand le projet lié est terminé, et demander confirmation avant d'en recréer un ;
  - **à terme** : une vente par victoire.
- **Effort** : S (option), M à L (modèle). A2-08, A1-15.

#### Q06 — Acompte puis solde, et facture de mensuel liée à la vente — priorité 2
- **Symptômes** :
  - après un acompte sur un revenu ponctuel, le solde ne peut plus être encaissé en un clic : il faut passer par une facture détaillée ;
  - une facture rattachée à un mensuel au moment de la vente ne couvre aucune échéance, ce qui fausse l'échéancier.
- **Cause** : `20261108000100_finance_revenus.sql:93` ; `ventes.sql:196-197`.
- **Preuve** : Vérifié (test).
- **Correction** : « Facturer le solde (X €) » tant que tout n'est pas facturé ; rattacher la facture à l'échéance la plus proche.
- **Effort** : S. A4-05, A4-06.

#### Q07 — Trois montants qui divergent sans signal — priorité 3
- **Symptôme** : une fiche à 12 000 € gagnée en mensuel à 1 000 € garde 12 000 €. Le Kanban, la Prospection et l'export lisent le montant de la fiche, tandis que Ventes lit le revenu. Le vocabulaire varie aussi (« mensuel » contre « récurrent », « mission » contre « revenu »).
- **Cause** : `ventes.sql:139` ; `src/components/sales/win-sale.tsx:71,75`.
- **Preuve** : Vérifié (test).
- **Correction** : choisir une règle (décision 9).
- **Effort** : S à M. A4-03, A1-09.

#### Q08 — Le client ne peut pas déposer un fichier sur une demande d'onboarding — priorité 2
- **Symptôme** : la demande attend un fichier « sur la tâche », mais le portail ne permet pas d'en joindre un. Vous devez rattacher le document à la main, alors que `docs/projets-depuis-gagne.md` promet ce dépôt.
- **Cause** : `src/components/portal/tasks.tsx` et `src/components/portal/files.tsx:20`. La route accepte déjà le lien avec la tâche (`src/app/api/portail/fichiers/route.ts:13,33`).
- **Preuve** : Lu (code).
- **Correction** : bouton « Déposer un fichier » dans le détail d'une tâche du portail.
- **Effort** : S. A3-02.

#### Q09 — Un chrono oublié plus de 7 jours ne peut plus être arrêté — priorité 3
- **Cause** : la limite de 7 jours en base (`20261110000100_temps.sql:18,79,95`).
- **Preuve** : Lu (code).
- **Correction** : plafonner l'heure de fin, puis proposer « Modifier ».
- **Effort** : S. A3-04.

#### Q10 — Le script de suppression des données [TEST] échoue dès qu'une vente existe — priorité 2
- **Symptôme** : `supabase/maintenance/delete-test-data.sql:9-27` ne supprime ni les ventes, ni les projets, ni la finance, ni les rendez-vous. Le bloc entier échoue donc dès qu'un parcours Gagné de test a eu lieu.
- **Preuve** : Lu (code).
- **Correction** : compléter le script dans le bon ordre, avec un test.
- **Effort** : S. **Dépendances** : à faire **avant** toute recette en production avec des données `[TEST]`. A1-10.

#### Q11 — La carte Ventes peut faire reculer un projet en cours — priorité 3
- **Symptôme** : remettre la carte sur « Devis / Contrat » ou « Onboarding » repasse le projet à « à préparer », même s'il était en cours.
- **Cause** : `ventes.sql:249-254`.
- **Preuve** : Vérifié (test).
- **Correction** : confirmation, ou refus du recul.
- **Effort** : XS à S. A1-07.

### D.3 Améliorations de confort

| Id | Symptôme | Preuve | Correction | Effort | Agents |
|---|---|---|---|---|---|
| K01 | Deux écrans du jour sur la même donnée : À faire montre tout, Aujourd'hui limite à 7 jours. Ouvrir l'application déclenche deux redirections. Focus n'a pas d'entrée de menu. | `a-faire/page.tsx:7`, `prospection/aujourdhui/page.tsx:17`, `(app)/page.tsx:4` (Lu) | Une page « Aujourd'hui » à la racine (voir E1) | M | A6-01/02/03, A2-11 |
| K02 | Quatre formulaires pour les revenus et factures, aux règles différentes. « Ajouter un revenu » ouvre en fait une facture. | `finance/forms.tsx:119, 461`, `revenue-forms.tsx:80`, `win-sale.tsx:116-139` (Lu) | Un seul formulaire de revenu (voir E2) | M | A6-07, A4-11 |
| K03 | Menu à 11 entrées ; sur téléphone, la barre du bas défile et masque des entrées. « Mail » et « Appels » sont surtout des réglages et une file de tri. | `app-shell.tsx:68-80, 188-205` (Lu ; rendu mobile non vu) | 5 entrées en bas, plus « Plus » (voir E3) | S | A6-04/10/12 |
| K04 | Agenda et Liste séparés ; le détail d'un rendez-vous par lien ne s'ouvre que depuis Liste. | `app-shell.tsx:61-62`, `lib/appointments/server.ts:120` (Lu) | Une page Agenda avec Jour / Semaine / Liste, en gardant les anciens liens (voir E4) | M | A6-11 |
| K05 | Libellés trompeurs : deux « Modèles » ; « Gérer les pipelines » dans Paramètres ; texte Gmail qui promet des envois programmés ; documentation de clôture périmée. | `app-shell.tsx:44`, `mail/tabs.tsx:5`, `parametres/page.tsx:32`, `lib/connectors/status.ts:36,62`, `docs/cloture-opportunite.md` (Lu) | Renommer et corriger les textes | XS | A6-09/15, A5-07, A2-12 |
| K06 | Une réponse ou un résultat de campagne enregistré deux fois crée un doublon dans l'historique. Focus enchaîne deux appels séparés. La création de tâche ne protège pas contre une nouvelle tentative. | `prospection_v2.sql:768-847`, `focus-session.tsx:500-514`, `record-tasks.tsx:22` (Vérifié, test) | Clé anti-doublon et une seule opération | S | A2-06, A3-13 |
| K07 | Si un doublon est signalé à la création, la saisie est perdue. Le formulaire « Nouvelle fiche » affiche tout d'emblée. | `create-company.tsx:88-158` (Lu) | « Compléter la fiche existante » ; champs avancés repliés | S | A2-09, A6-08 |
| K08 | La recherche ⌘K ne trouve que des fiches ; le seul raccourci de création est « Nouvelle fiche ». | `search-palette.tsx:31-35`, `app-shell.tsx:180-187` (Lu) | Ajouter « Aller à… » et « Créer… » (tâche, revenu, note) | S | A6-05/06 |
| K09 | Pas de temps par projet. Un appel Fireflies ne peut pas être rattaché à un projet. | `temps.sql:8-20`, `projets_planning_points.sql:48` (Lu) | Projet facultatif sur le temps et sur l'appel | M | A3-05, A5-12 |
| K10 | Après Gagné : « Documents validés » à cocher même si un contrat est joint ; la préparation ne se relance pas quand une pièce est ajoutée ; deux mécanismes de préparation coexistent. | `lib/sales/service.ts:138-182`, `projet_onboarding.sql:366-390` (Lu) | Une seule source pour l'état de préparation, relance automatique | S à M | A2-10, A1-09 |
| K11 | Portail : l'aperçu ne signale pas que le client ne voit rien (projet non publié, accès expiré) ; une limite globale de connexion permet de bloquer tous les clients ; un dépôt supprimé par le client disparaît aussi de la fiche ; le partage des slides n'est pas atomique. | `projets/[id]/apercu/page.tsx:15-33`, `projets.sql:341-349`, `projets_dossiers_points.sql:301-320`, `lib/projects/onboarding.ts:173-188` (Lu) | Bandeau d'état dans l'aperçu ; limite par code ; retrait de la seule référence au projet | S chacun | A3-11/12/14/15 |
| K12 | Performance (voir E6). Mesuré : Finance 331 Ko compressés, modèles d'email 356 Ko compressés. Lu dans le code : un onglet de campagne recharge tout l'espace de la campagne ; chaque page Finance fait une écriture et 11 lectures ; il manque un index sur `meta->>'campaign_id'`. | `.next` du build (Mesuré) ; `lib/prospection/service.ts:115-150`, `finance/load.ts:8-11` (Lu) | Chargements ciblés, graphiques et éditeur chargés à la demande, index | XS à M | A6-16 à 28 |
| K13 | Code mort : 32 exports jamais utilisés dans `src/`, dont 10 actions serveur, et une route avec des branches mortes. | liste dans l'annexe 1 (Lu ; `tests/` non vérifié) | Supprimer après vérification dans les tests | S | A6-13/14, A2-12 |
| K14 | Intégrations, petits points : l'état « Connecté » du MCP ne teste pas le serveur ; la personne manque dans l'historique email ; les portées OAuth du MCP ne sont pas utilisées ; Fireflies ne refait le rattachement qu'une fois par jour ; la redirection Gmail dépend de l'URL d'appel ; pas de contrôle d'ancienneté du webhook ; Ventes n'est pas rafraîchi après une action Finance ; petits écarts de calcul TTC/HT et d'arrondi. | `lib/connectors/status.ts:247-266`, `mail_envoi.sql:137-187`, `api/mail/oauth/*`, `fireflies/webhook/route.ts:16-21`, `calc.ts:442-450` (Lu) | Corrections ponctuelles | XS à S chacun | A5-09 à 15, A4-12/13 |

---

## E. Simplifications proposées

Aucune donnée d'usage n'est disponible : la confiance porte sur le doublon technique, pas sur votre usage réel.

| # | Élément | Proposition | Ce que vous gagnez | Ce que vous perdez | Confiance | Effets sur les autres modules et les données |
|---|---|---|---|---|---|---|
| E1 | À faire, Aujourd'hui, Réponses, Focus | **Regrouper** en une page « Aujourd'hui » à la racine, en 1re position du menu : relances (avec Focus), tâches CRM et de projet, réponses, appels à rattacher. `/a-faire` redirige vers elle avec le filtre « tout voir ». | Un seul endroit le matin, une entrée de menu en moins | La liste « toutes échéances » passe derrière un filtre | Moyenne | Compteur du menu ; aucune donnée modifiée ; l'outil Claude `list_followups` n'est pas touché |
| E2 | `MissionModal`, `RevenueModal`, `InvoiceModal`, bloc revenu de Gagné | **Regrouper** sur un seul formulaire de revenu ; renommer la facture « Facture » | Un vocabulaire, des règles identiques ; supprime la cause de C04 | L'édition libre de la « prochaine échéance », qui est de toute façon calculée | Moyenne à élevée | Finance › Clients ; tests Finance ; aucune migration |
| E3 | Menu principal (11 entrées) | **Alléger** : sortir « Mail » (modèles vers Paramètres, envois vers Connecteurs) et « Appels » (vers Aujourd'hui et la fiche) ; mobile à 5 entrées plus « Plus » | Menu lisible, entrées visibles sur téléphone | Un clic de plus vers les envois Gmail | Faible à moyenne | Les anciennes adresses restent valides |
| E4 | Rendez-vous : Agenda, Liste, Connexion agenda | **Regrouper** Agenda et Liste ; « Connexion agenda » ne reste que dans Connecteurs | 6 sous-onglets ramenés à 4 | Aucune fonction | Moyenne | **Garder la redirection `/rendez-vous/liste?rdv=`**, déjà écrite dans les événements Google existants |
| E5 | Ventes › Suivi, Finance › Clients actifs, Projets | **Clarifier sans retirer** : renommer « Clients actifs » en « Revenus par client » ; liens croisés vente ↔ revenu ↔ projet | Moins de « où est mon client ? » | Rien | Moyenne à faible | Aucun |
| E6 | Chargements lourds | **Alléger** : graphiques Finance et éditeur d'email chargés à la demande ; chargement par onglet des campagnes ; génération des échéances une fois par jour au lieu de chaque page | Pages plus légères (mesuré pour le poids, non mesuré pour le temps) | Rien | Élevée pour le poids, hypothèse pour le temps | Aucun |
| E7 | Deux états de préparation (vente et onboarding) | **Une seule source** : l'onboarding ; la vente le lit | Plus de divergence possible | Rien | Moyenne | Migration légère |
| E8 | Code mort (32 exports, branches mortes de `/api/pipelines/[id]/cards`, `onboardingHref`) | **Retirer**, après vérification dans `tests/` | Moins de surface et de maintenance | Rien si la vérification est faite | Moyenne | Aucun |
| E9 | « Gérer les pipelines » dans Paramètres | **Retirer ou renommer** « Ouvrir Pipelines » | Un chemin clair | Rien | Moyenne | Aucun |

**À ne pas retirer sans données d'usage** : Focus, Réponses à traiter, la boîte à idées du portail, Rentabilité, la simulation Finance. Ce sont des fonctions complètes ; rien ne prouve qu'elles sont inutiles.

---

## F. Plan de travail proposé

Chaque lot est petit, testable sur la base de test et livrable seul. L'ordre suit l'impact sur vos données, puis sur votre temps.

| Lot | Contenu | Réussi quand… | Effort |
|---|---|---|---|
| **0. Préalables** | C15 (selon votre réponse à la décision 14), Q10 (script [TEST]), K05 (textes trompeurs) | `supabase db push` ne bute plus sur le numéro en double ; le script supprime une fiche [TEST] gagnée avec projet et facture (test) ; plus aucun texte ne promet une fonction absente | S |
| **1. Ventes protégées** | C01, C03, C10, Q11 | Test : déplacer une fiche gagnée est refusé sans « Rouvrir », y compris par Claude ; perdre une vente rouverte propose d'archiver le projet et d'arrêter le revenu ; confirmer une vente dont le revenu a été supprimé fonctionne | M |
| **2. Fusion complète** | C02 | Test : après une fusion, projets, rendez-vous et ventes sont sur la fiche conservée ; deux ventes en conflit sont refusées avec un message ; rattrapage des fusions passées | M |
| **3. Finance juste** | C04, C05, Q06, puis E2 | Tests : « Encaissé » seulement quand tout est réglé ; une facture ne peut pas viser le revenu d'un autre client ; un revenu terminé n'est plus compté ; le solde s'encaisse en un clic | M |
| **4. Une seule journée** | Q01, E1, Q04 | Une tâche de projet à moi apparaît dans « Aujourd'hui » et sa validation se reflète dans le projet ; « RDV obtenu » laisse toujours une suite | M |
| **5. Rendez-vous fiables** | C07, C08, Q02 (court terme), C09 (minimum) | La tâche planifiée appelle la reprise sans 401 (test du proxy) ; agenda déconnecté, la page publique est suspendue ou avertit ; l'invité reçoit l'invitation Google (selon la décision 6) | S à M |
| **6. Portail sans surprise** | C06, Q08, K11 (aperçu) | Partager un document demande confirmation ; le client dépose un fichier sur une demande d'onboarding ; l'aperçu dit si le client voit réellement le projet | M |
| **7. Confort et menu** | E3, E4, K06, K07, K08, E9 | Menu mobile à 5 entrées ; plus de doublons de réponses ; aucune saisie perdue sur doublon | M |
| **8. Performance** | E6, K12, après mesure sur une base de test | Temps mesurés avant et après sur une copie anonymisée ; poids des pages Finance et Modèles réduit | S à M |
| **Plus tard** | Q03 (réception Gmail), Q05 (une vente par victoire), K09 (temps et appels par projet), C13, file d'envoi d'emails | À cadrer séparément | L |

**Prérequis transversal** : une base Supabase de test reliée à une copie locale de l'application. Sans elle, aucun lot ne peut être vérifié dans le navigateur. Aujourd'hui, `.env.local` pointe vers la production.

---

## G. Décisions à me soumettre

Répondez simplement, par exemple : « Valider 1, 2, 4 ; garder 11 ; reporter 12 ».

1. **Verrouiller les ventes clôturées** : on ne rouvre que par « Rouvrir », jamais par un changement d'étape, ni depuis Claude, ni depuis une campagne (lot 1).
2. **Au passage à Perdu après une réouverture**, proposer d'archiver le projet et d'arrêter le revenu, sur confirmation, jamais d'office (lot 1).
3. **Fusion de deux fiches qui ont chacune une vente** : (a) la refuser avec un message, ou (b) garder une vente et archiver l'autre avec une trace. Je recommande (a) (lot 2).
4. **Lancer le lot Finance** (lot 3), formulaire unique de revenu compris.
5. **Une seule page « Aujourd'hui »** qui remplace À faire et inclut les tâches de projet (lot 4).
6. **Invitations Google envoyées à l'invité** (`sendUpdates=all`) en attendant la file d'envoi. Google affichera votre adresse d'organisateur.
7. **Agenda déconnecté** : (a) suspendre automatiquement la page publique, ou (b) seulement afficher un avertissement. Je recommande (a).
8. **Partage vers le portail** : confirmation obligatoire et choix du dossier (lot 6).
9. **Montant de la fiche après Gagné** : (a) il devient la valeur du contrat (ponctuel = montant ; mensuel = montant par mois, avec la mention « / mois »), ou (b) les deux montants restent et l'écart est affiché.
10. **Client qui revient** : (a) court terme, option « nouveau projet » quand le précédent est terminé, ou (b) passer au modèle « une vente par victoire » (plus lourd).
11. **Menu** : sortir Mail et Appels du premier niveau, regrouper Agenda et Liste, menu mobile à 5 entrées (lot 7).
12. **Réception des emails Gmail** (nouvelle autorisation Google en lecture) : lancer maintenant ou reporter.
13. **Temps par projet** : en avez-vous besoin pour facturer ?
14. **Information à me donner** : la production a-t-elle été migrée avec l'éditeur SQL (`install.sql`) ou avec `supabase db push` ? La correction de C15 en dépend.
15. **Base de test** : créer un projet Supabase de test dédié, pour vérifier les lots dans le navigateur sans toucher à la production.

---

## Annexe 1 — Détails utiles

**Exports jamais utilisés dans `src/`** (vérifier `tests/` avant de supprimer quoi que ce soit) :
- **Actions serveur** :
  - `src/app/actions.ts` : `getCompanyAction`, `saveTemplateAction`, `addListsToCampaignAction`, `addCompaniesToCampaignAction`, `archiveCampaignAction`, `markStepSentAction`, `updateParticipantAction` ;
  - `src/app/prospection-actions.ts` : `getFocusQueueAction`, `setPreferenceAction` ;
  - `src/app/rendez-vous-actions.ts` : `newIdempotencyKey`.
- **Interface** : `Kpi`, `CashChart`, `CategoryChart`, `onboardingHref`.
- **Bibliothèques** : `findDuplicates`, `monthlyCashSeries`, `paidByCategory`, `periodKpis`, `hasActivity`, `upcomingDeadlines`, `dueReminders`, `connectMailDelivery`, `bookingEventsSince`, `getPreference`, `onboardingPrompt`, `splitByDay`, `formatTime`, `PARTICIPANT_STATUS_LABELS`, `isEmptyHtml`.
- **Attention** : `dueReminders`, `connectMailDelivery` et `bookingEventsSince` sont le raccordement prévu pour les rappels de rendez-vous (Q02). Ce ne sont pas des déchets.

**Mesures réelles du build** (JavaScript chargé à l'ouverture, compressé) :

| Partie | Poids compressé |
|---|---|
| Socle de l'espace connecté | ≈ 221 Ko |
| `/mail/modeles` | 356 Ko |
| `/finance/rentabilite` | 332 Ko |
| `/finance` | 331 Ko |
| `/rendez-vous/types/[id]` | 269 Ko (zod embarqué pour une seule fonction) |
| Portail client | 166 à 187 Ko |

Le build passe sans aucune variable d'environnement.

**Variables d'environnement** (noms seulement) :
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL` ;
- `APPOINTMENTS_SECRET`, qui sert aussi à Fireflies et au portail ;
- `GOOGLE_CALENDAR_CLIENT_ID` et `GOOGLE_CALENDAR_CLIENT_SECRET` (ou les `GOOGLE_CLIENT_*` génériques) ;
- `GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET`, `MAIL_TOKEN_KEY` ;
- `FIREFLIES_API_KEY`, `FIREFLIES_WEBHOOK_SECRET`, `CRON_SECRET` ;
- `DIAGNOSTIC_ROUTINE_URL/TOKEN` et `ONBOARDING_ROUTINE_URL/TOKEN`, facultatifs.

Aucun secret n'a été trouvé en clair dans le dépôt.

**Connecteurs réellement présents** :

| Connecteur | État |
|---|---|
| Gmail | Envoi seulement |
| Google Agenda et Meet | Présents |
| Fireflies | Présent |
| Claude (MCP) | Présent ; inaccessible depuis cette machine |
| Routines Claude (diagnostic, onboarding) | Dépendent d'une configuration externe |
| Ubersuggest | Simple carte d'information, aucune intégration côté CRM |
| Calendly, Stripe, Slack, Outlook, LinkedIn | Aucun |

## Annexe 2 — Confrontation des agents

- **Doublons fusionnés** :
  - la fusion de fiches a été signalée par trois agents (C02) ;
  - « Perdu sans effet » par trois agents (C03) ;
  - « Encaissé » trompeur par deux agents (C05) ;
  - factures et revenus mal protégés par deux agents (C04) ;
  - tâches de projet hors d'À faire par trois agents (Q01) ;
  - écrans du jour en double par deux agents (K01).
- **Contradictions résolues** :
  - L'agent Finance écrivait que « la fusion fait suivre la vente ». C'est vrai seulement si la fiche conservée n'a pas déjà de vente : les deux autres agents l'ont prouvé par test (C02).
  - L'agent Projets avait classé la fusion « non testée ». Elle a été vérifiée par test par les agents Données et Commercial.
  - La ligne citée pour `move_company` était erronée chez un agent. La bonne référence est `functions.sql:769`, recontrôlée.
- **Recontrôlés par moi dans le code** :
  - C01 : `functions.sql:769` ;
  - C04 : `clients-view.tsx:162` et `forms.tsx:127` ;
  - C07 : `proxy.ts:9,30` et `vercel.json` ;
  - C15 : liste des migrations ;
  - Q01 : `prospection_v2.sql:929-939`.
- **Tests relancés par moi** :
  - la suite complète du dépôt (579 sur 579) ;
  - les tests temporaires des agents, écrits hors du dépôt et non versionnés : 11 (Données), 8 (Finance) et 7 (Commercial), tous réussis.
