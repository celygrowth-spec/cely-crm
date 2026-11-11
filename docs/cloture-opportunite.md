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

Toute clôture passe par la fonction SQL `set_deal_status(p_company, p_status, p_lost_reason, p_closed_on, p_amount)`,
appelée par `setDealStatus` (`src/lib/crm/service.ts`) → `setDealStatusAction` (`src/app/actions.ts`) →
`useDealStatus` (`src/components/deal-closing.tsx`), utilisé à la fois par la fiche (`RecordDealClosing`) et par les
cartes du Kanban (`CardClosingMenu`).

- **Gagné** : date de signature (aujourd'hui par défaut, jamais dans le futur ; un autre jour est enregistré à midi,
  heure de Paris), montant facultatif.
- **Perdu** : motif facultatif (500 caractères au plus).
- **Rouvrir** : la fiche retrouve sa dernière étape (la première du pipeline si elle n'en a plus). Un projet lié est
  signalé dans la trace et **conservé**.
- Une opportunité clôturée doit être rouverte avant de changer d'issue ; répéter la même demande ne change rien.
- Chaque changement est inscrit dans l'activité de la fiche (`interactions.kind = 'deal_status'`, texte daté et
  détails dans `meta`) et apparaît comme un jalon dans le fil « Tout ».
- **Une fiche gagnée ou perdue reste clôturée** (audit C01) : changer d'étape, choisir « Hors pipeline », une
  campagne (« Intéressé + étape ») ou Claude (`move_company`) sont refusés avec une explication ; la base l'impose
  (déclencheur `companies_closed_guard`). Seules « Rouvrir l'opportunité » et « Nouvelle opportunité » rouvrent.
- **Rouvrir ou perdre une vente qui a un projet, un revenu ou des accès client** passe par `deal_transition` : vous
  décidez du sort du projet (continue, en attente, archivé), des échéances futures (continuent ou s'arrêtent à une
  date) et des accès au portail (maintenus ou révoqués) ; tout s'applique en une opération (audit C03).

## Raccordement avec Ventes et Projets

Depuis la version Ventes, « Gagné » ouvre « Marquer comme gagné » (voir `docs/ventes.md`) : la vente, le revenu
et le projet sont créés ou liés en une fois. Ce qui suit reste valable pour créer un projet à la main.

### Création manuelle d'un projet

Marquer une fiche gagnée **ne crée rien** dans Projets : la signature et la création du projet restent deux actions.

- Depuis la fiche gagnée (bouton « Préparer l'onboarding ») ou la notification de la carte du Kanban :
  la fenêtre « Nouveau projet » s'ouvre avec le client prérempli (`CreateProjectModal`, prop `company`).
- Depuis n'importe où : **`/projets?nouveau=1&client=<company_id>`** (`onboardingHref` dans
  `src/components/deal-closing.tsx`) ouvre la même fenêtre préremplie.

L'entreprise, ses personnes et son historique restent sur la même fiche : un projet référence `projects.company_id`.
Une autre branche qui ajoute un parcours d'onboarding n'a qu'à remplacer la cible de `onboardingHref` ou ce que la
fenêtre ouvre, sans toucher à la clôture.

Migration : `supabase/migrations/20261112000100_cloture_opportunite.sql` (additive).
