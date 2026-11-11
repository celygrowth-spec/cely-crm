# Aujourd'hui : le point d'entrée de la journée

Adresse : `/` (page d'accueil après connexion, première entrée du menu). Les anciennes adresses restent valables :
`/a-faire` ouvre « Aujourd'hui » sur la vue complète (`/?vue=tout`), `/prospection/aujourdhui` ouvre `/`.

## Ce qu'on y trouve (une seule source : la vue `todo_items`)
- **Tâches** : tâches CRM des fiches et **tâches de projet qui me sont attribuées** (projets actifs). Une tâche de
  projet se valide ici sur la tâche d'origine : elle est aussitôt terminée dans le projet (et dans le portail si elle
  y est visible). Une tâche de projet sans échéance n'apparaît que dans la vue « Tout ».
- **Relances de prospection** (en retard, du jour, à venir) avec « Relances en mode Focus » (Focus reste le mode
  d'exécution des relances) et un Focus par campagne.
- **Réponses à traiter** et **appels à rattacher** : bandeaux avec le nombre et un lien.
- Filtre de période : aujourd'hui et en retard (par défaut), 7 prochains jours, tout (échéances futures comprises).

Le compteur du menu (`nav_counters`) applique les mêmes règles ; la « prochaine action » d'une fiche aussi.

## Une suite après « Intéressé » ou « RDV obtenu »
Dans Focus, Réponses à traiter et le panneau d'un participant, ces deux résultats demandent la suite : tâche de suivi
(proposée par défaut), étape du pipeline, ou « rendez-vous déjà planifié ». La base refuse un résultat qui ne laisse
aucune suite (pas d'étape, pas de rendez-vous à venir, pas de tâche ouverte) : la fiche ne sort plus de toutes les
listes.

## Une seule fois
Réponse et résultat s'enregistrent en une opération (tout ou rien). Chaque saisie porte une clé : un double clic ou
une reprise réseau ne crée ni réponse en double dans l'historique, ni tâche en double. Même règle pour la création
d'une tâche depuis une fiche.
