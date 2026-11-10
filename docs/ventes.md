# Ventes : clôture, projet client et facturation

**Pipelines** = opportunités ouvertes. Dès qu'une fiche passe Gagné ou Perdu, elle quitte le tableau et se retrouve
dans **Ventes** (même fiche, mêmes contacts, même historique).

## Source de vérité

| Donnée | Où |
| --- | --- |
| Issue commerciale (ouverte / gagnée / perdue), date de clôture, motif | `companies.deal_status`, `deal_closed_at`, `lost_reason` |
| Vente suivie (une par fiche : référence stable) | `sales` : date de clôture, date de signature (si connue), type de revenu, revenu lié, projet lié, documents validés, préparation |
| Revenu prévu, factures, règlements | Finance : `finance_missions`, `finance_invoices`, `finance_payments` (jamais recopiés) |
| Avancement après-vente | `sales.documents_ready` + `projects.status` (un seul état, partagé avec Projets) |

La vue `sales_overview` assemble le tout pour Ventes, la fiche et Projets. Les ventes déjà gagnées ou perdues y
apparaissent dès la mise en ligne, sans migration de données ni création en masse.

## Ventes

- **Chiffres** sur la période choisie : Gagnées, Perdues, Taux de réussite = gagnées ÷ (gagnées + perdues) ; « — » sans clôture.
  La même période filtre les listes Gagnées et Perdues.
- **Suivi clients** (par défaut, indépendant de la période) :

  | Colonne | Règle | Action principale |
  | --- | --- | --- |
  | Devis / Contrat | vente gagnée, documents pas encore validés | Finaliser le dossier |
  | Onboarding | documents validés, projet « à préparer » | Ouvrir l'onboarding |
  | En mission | projet en cours ou en attente | Ouvrir le projet |

  Un projet terminé ou archivé fait quitter le tableau ; la vente reste dans Gagnées.
- **Gagnées** : client, date de clôture, montant et type, projet, facturation (à renseigner / prévu / facturé / encaissé).
- **Perdues** : client, date, dernière étape, motif.

## « Marquer comme gagné » (fiche, Kanban, Ventes)

Un seul formulaire : date de clôture (aujourd'hui), date de signature si connue, documents déjà signés, revenu
**Mensuel** (montant par mois, début, fin facultative), **Ponctuel** (montant, encaissement prévu) ou
**Renseigner plus tard**. Si un revenu, une facture ou un projet existent déjà pour le client, ils sont proposés
pour être liés. « Confirmer la vente » appelle `sale_confirm`, en une transaction :

1. la fiche passe Gagné (trace datée dans l'activité, `set_deal_status`) ;
2. la vente suivie est créée ou retrouvée (une par fiche) ;
3. le revenu est lié ou créé via `finance_add_revenue` (clé stable `sale-revenue:<vente>`) ; une facture existante
   est rattachée au revenu ;
4. le projet est lié ou créé une seule fois (`project_create`, statut « à préparer ») ;
5. la préparation repart en arrière-plan (`after()`), pendant que l'interface rend la main.

La clé d'idempotence du formulaire ne change pas pendant qu'il est ouvert : un double clic ou un « Réessayer » après
erreur renvoient le même résultat. Même sans clé, la vente unique par fiche empêche tout doublon de projet ou de revenu.

Facturation : **prévu** dès que le revenu existe (il apparaît dans les prévisions Finance), **facturé** quand une
facture est enregistrée sur ce revenu, **encaissé** quand elle est réglée. Depuis la carte : « Préparer la facture »
ouvre le revenu dans Finance (`/finance/revenus?revenu=<id>`) ; « Lier une facture » rattache une facture déjà enregistrée.

## Préparation de l'onboarding (Projets)

`prepareSale` (`src/lib/sales/service.ts`) rassemble, sans rien publier :

- la proposition acceptée et le contrat (documents de la fiche, catégories « Proposition » et « Contrat ») ;
- les trois derniers appels Fireflies rattachés à la fiche (résumé et actions) ;
- la dernière version du diagnostic ;
- le revenu prévu.

Elle les écrit dans la **note interne** du projet (jamais visible du client ; une note écrite à la main n'est pas
remplacée) et liste les éléments manquants : proposition, contact client avec email, date de démarrage
(obligatoires) ; contrat, compte rendu ou diagnostic (facultatifs). Le projet affiche ces éléments avec un lien
vers le bon écran ; la carte Ventes indique « N éléments à compléter ». Quand tout est prêt, **« Générer les slides
d'onboarding »** ouvre Claude avec l'identifiant du projet seulement : Claude lit le projet par le connecteur du CRM
(`get_project`, `get_company`) et ne publie rien. Une préparation interrompue se reprend depuis la carte ou le projet,
en voyant ce qui est déjà enregistré.

Limite actuelle : le contenu des fichiers (PDF de la proposition) n'est pas lu par la préparation automatique ; il
est référencé, et Claude le consulte lors de la génération des slides.

## Réouverture

Rouvrir une vente gagnée demande une décision explicite si un projet ou un revenu est lié : ils restent liés
(`sales.state = 'reopened'`) et sont réutilisés si la fiche est regagnée. Un revenu mensuel peut être arrêté au
passage, seulement sur demande. Un projet n'est jamais supprimé.

## Anciens dossiers

Une fiche gagnée avant cette version apparaît dans Gagnées avec « Compléter ». Les liens fiables sont proposés
(un seul revenu libre, un seul projet actif sur la fiche) ; rien n'est deviné quand il y en a plusieurs. Un ancien
client dont le projet est encore en cours reste visible dans « En mission ».

Migration : `supabase/migrations/20261113000100_ventes.sql` (additive).
