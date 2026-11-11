# Clôturer une opportunité (Gagné / Perdu / Rouvrir)

## Une seule source de vérité

| Donnée | Rôle |
| --- | --- |
| `companies.stage_id` (et `pipeline_id`) | **Progression commerciale** : l'étape du pipeline. Une clôture ne la change jamais. |
| `companies.deal_status` (`open` / `won` / `lost`) | **Issue** de l'opportunité. |
| `companies.deal_closed_at` | Date de signature (Gagné) ou de perte (Perdu) ; vide quand l'opportunité est ouverte. |
| `companies.amount` | Montant ; Gagné peut le confirmer ou le corriger (facultatif). |
| `companies.lost_reason` | Motif de perte (facultatif). |

La fiche (en-tête et onglet Détails), le Kanban (cartes, filtre « Opportunités ouvertes / Gagnées / Perdues »
et ses compteurs), la liste Prospection, l'export, Finance › Clients et le serveur MCP lisent tous ces mêmes colonnes.

## Une seule logique

Toutes les commandes vivent dans `src/components/deal-closing.tsx` et sont les mêmes sur la fiche
(`RecordDealClosing` / `DealClosingControls`) et sur les cartes du Kanban (`CardClosingMenu`).

- **Gagné** : ouvre « Marquer comme gagné » (`WinSaleDialog`, voir `docs/ventes.md`) : date de signature,
  montant, revenu et projet sont créés ou liés en une fois.
- **Perdu** : `TransitionForm` → `dealTransitionAction` (`src/app/sales-actions.ts`) → fonction SQL
  `deal_transition`. Motif facultatif (500 caractères au plus) ; si un projet, un revenu ou des accès client
  sont liés, vous décidez de leur sort dans le même formulaire (voir ci-dessous).
- **Rouvrir l'opportunité** (badge Gagné / Perdu de la fiche) : même formulaire et même fonction
  `deal_transition`, avec les décisions suivantes quand ces éléments existent :
  - **projet** lié : continue, passe en attente, ou est archivé ;
  - **revenu** lié : les échéances futures continuent, ou s'arrêtent à une date (mensuel) ; la prévision reste
    ou est retirée (ponctuel). Factures et règlements déjà enregistrés gardent leur historique ;
  - **accès client** au portail : maintenus ou révoqués (une personne qui suit un autre projet actif garde
    son accès).

  Sans élément lié, la fiche retrouve simplement sa dernière étape dans Pipelines. Tout s'applique en une
  opération, ou rien ; en cas d'erreur, la saisie reste à l'écran (audit C03). « Rouvrir » sert à **corriger
  une clôture**.
- **Nouvelle opportunité** (fiche gagnée) : pour un **client qui revient** pour une nouvelle mission
  (`newOpportunityAction` → `deal_new_opportunity`, audit Q05). Même fiche, mêmes contacts ; vous choisissez
  l'étape de départ. La vente précédente, son projet et son revenu restent consultables dans Ventes.
- Une opportunité clôturée doit être rouverte avant de changer d'issue ; répéter la même demande ne change rien
  (clé d'idempotence).
- Chaque changement est inscrit dans l'activité de la fiche et apparaît comme un jalon dans le fil « Tout ».
- **Une fiche gagnée ou perdue reste clôturée** (audit C01) : changer d'étape, choisir « Hors pipeline », une
  campagne (« Intéressé + étape ») ou Claude (`move_company`) sont refusés avec une explication ; la base l'impose
  (déclencheur `companies_closed_guard`). Seules « Rouvrir l'opportunité » et « Nouvelle opportunité » rouvrent.

## Raccordement avec Ventes et Projets

« Gagné » ouvre « Marquer comme gagné » (voir `docs/ventes.md`) : la vente, le revenu et le projet sont créés
ou liés en une fois. Ce qui suit reste valable pour créer un projet à la main.

### Création manuelle d'un projet

Si le projet n'a pas été créé dans « Marquer comme gagné », il peut l'être ensuite :

- Depuis la fiche (section « Fichiers et projets » › « Nouveau projet ») : la fenêtre « Nouveau projet » s'ouvre
  avec le client prérempli (`CreateProjectModal`, prop `company`).
- Depuis n'importe où : **`/projets?nouveau=1&client=<company_id>`** ouvre la même fenêtre préremplie.

L'entreprise, ses personnes et son historique restent sur la même fiche : un projet référence `projects.company_id`.

Migration : `supabase/migrations/20261112000100_cloture_opportunite.sql` (additive).
