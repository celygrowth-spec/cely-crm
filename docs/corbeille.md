# Corbeille

Supprimer un élément le met à la corbeille : il disparaît de tout le CRM (listes, recherche, Aujourd'hui, totaux de
Finance, Ventes, exports, connecteur Claude) et du portail client, et se restaure à l'identique pendant 30 jours depuis
la page **Corbeille**. Après 30 jours, il est supprimé définitivement avec ses éléments liés et leurs fichiers.

## Ce qui se supprime et ce qui part avec

| Élément | Part avec lui | Reste en place |
| --- | --- | --- |
| Règlement | — | la facture (son reste à encaisser remonte) |
| Facture ou avoir | ses règlements, ses avoirs et leurs remboursements | son numéro reste réservé (jamais réattribué) |
| Revenu | ses factures (et ce qui part avec elles) | la vente liée, sans ce revenu |
| Tâche de projet | ses commentaires | les fichiers qui y étaient liés |
| Idée | ses commentaires | la tâche créée à partir de l'idée |
| Phase du planning | ses jalons | — |
| Point de suivi | son récapitulatif | le rendez-vous dans l'agenda |
| Projet client | tâches, idées, planning, points, dossiers, liens vers les documents, historique, onboarding ; l'accès de ses contacts à ce projet au portail | les documents (sur la fiche et dans les autres projets), les rendez-vous, la vente, le temps passé |
| Contact | son accès au portail, sa place dans les projets | ses échanges, tâches et rendez-vous sur la fiche |
| Entreprise | contacts et accès au portail, vente, relances, historique, revenus, factures, règlements, projets, fichiers, diagnostics, campagnes, temps, mails, appels | les rendez-vous (dans l'agenda, sans fiche tant qu'elle est à la corbeille) |

La suppression ne déclenche aucune action externe (aucun mail, aucun changement d'agenda). Elle est réservée au
propriétaire ; les contacts du portail n'y ont pas accès. Claude passe par la corbeille (`move_to_trash` et les outils
de suppression des espaces client) ; restaurer et supprimer définitivement se font dans l'application.

## Comment c'est garanti

- L'élément reste en base, inchangé : ses lignes (et celles de ses liés) sont inscrites dans `trash_rows`. Une politique
  d'accès **restrictive** (`trash_hidden`) sur chaque table concernée les rend invisibles à toute lecture de l'API.
  Les fonctions privilégiées du portail filtrent explicitement (`public.in_trash`).
- Mise à la corbeille et restauration sont une seule transaction (tout ou rien). Un double clic renvoie le même élément.
- Restaurer un élément dont le parent est à la corbeille : rien n'est fait, la Corbeille propose de restaurer les deux.
- Seule exception à « rien n'est réécrit » : un contact principal mis à la corbeille libère sa place (pour qu'un autre
  puisse être désigné) et la retrouve à la restauration si elle est libre.

## Purge automatique

Passage planifié « corbeille » de `/api/cron` (Vercel Cron, chaque jour à 5 h UTC, ou « Lancer maintenant » dans
Paramètres › Passages planifiés). Il supprime les éléments arrivés à 30 jours, puis retire leurs fichiers du stockage
grâce à une autorisation temporaire posée par la base (même mécanisme que le portail). Un fichier déjà absent compte
comme retiré ; un échec est noté sur l'élément et réessayé au passage suivant.

Variables nécessaires (déjà utilisées par les autres passages) : `CRON_SECRET`, `APPOINTMENTS_SECRET` (d'où dérive la
clé serveur ; elle doit avoir été enregistrée une fois, par exemple avec « Lancer maintenant »), `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`. Le planificateur Supabase de `supabase/maintenance/planificateur.sql` ne lance pas la
corbeille (`?taches=rappels,gmail,agenda`) : la purge quotidienne de Vercel suffit.

## Limites connues

- Les rattachements automatiques d'autres modules (mail reçu, rendez-vous, appel Fireflies) peuvent encore viser une
  fiche à la corbeille : ces nouvelles lignes sont cachées avec elle et reviennent à la restauration.
- Pendant le séjour d'une facture en corbeille, une nouvelle facture peut couvrir la même échéance d'un revenu
  mensuel ; à la restauration, l'échéance peut se retrouver facturée deux fois (à vérifier à la main).
- Une fiche, une étape ou un pipeline encore référencés par un élément à la corbeille ne peuvent pas être supprimés
  directement (message « encore utilisé ailleurs ») tant que l'élément n'est pas restauré ou purgé.
