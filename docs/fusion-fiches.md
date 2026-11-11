# Fusion de fiches (doublons)

Prospection › Doublons › Fusionner. La fiche absorbée garde son identifiant, qui redirige vers la fiche conservée.

## Ce qui est rattaché
Tout ce qui est lié à la fiche absorbée passe sur la fiche conservée, en une seule opération (`merge_companies`) :
personnes, historique, tâches, campagnes, ventes (renumérotées à la suite : vente n° 1, 2…), revenus, factures,
règlements, projets et leur contenu, rendez-vous, fichiers, emails, appels, diagnostics et temps.

## Avant de confirmer
L'écran affiche l'aperçu calculé par la base (`merge_preview`) : nombre d'éléments rattachés, points d'attention
(plusieurs projets actifs, position commerciale à garder) et blocages.

**Blocage** : les deux fiches ont chacune une vente en cours. La procédure ne sait pas choisir sûrement : terminez
l'une des deux ou marquez-la perdue (Ventes), puis fusionnez. La position commerciale gardée (issue Gagné/Perdu)
doit correspondre à la vente en cours ; sinon la base refuse avec une explication.

## Fusions faites avant cette version
Les anciennes fusions ne déplaçaient pas projets, rendez-vous, ventes, revenus et factures.

1. `supabase/maintenance/diagnostic-fusions.sql` — lecture seule : liste, pour chaque fiche absorbée, ce qui est
   resté dessus et la fiche finale (chaînes de fusions suivies).
2. `supabase/maintenance/rattrapage-fusions.sql` — d'abord l'aperçu (lecture seule), puis le bloc d'application.
   Il déplace tout vers la fiche finale, sauf les cas ambigus (vente en cours des deux côtés, ou issue
   incompatible) qui restent en place et sont comptés comme « ignorés » : à régler à la main, puis relancer.
   Relancer le script ne refait rien sur ce qui est déjà rattrapé.

À exécuter en production uniquement sur instruction explicite, après la migration `20261115000200_fusion_complete.sql`.
