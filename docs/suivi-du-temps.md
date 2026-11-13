# Suivi du temps (menu « Productivité › Temps »)

Lancer un chrono pour un client, travailler, l'arrêter ; voir ensuite le temps passé par client sur une période.

Adresse : `/productivite/temps`. L'ancienne adresse `/temps` redirige vers elle, paramètres compris.

## Chrono

- **Démarrer un chrono** : menu Temps, ou fiche client (action rapide, client déjà choisi). Clients récents en
  premier, recherche dans toutes les fiches du CRM. Libellé facultatif.
- **Pastille** visible partout dans l'espace CRM : client, temps écoulé, **Arrêter**. Un clic sur le nom ouvre Temps.
- **Un seul chrono à la fois**. Démarrer pour un autre client affiche « Arrêter et démarrer » : la première
  session est enregistrée, puis la nouvelle démarre. Garanti en base (index unique, verrou) : un double clic ou
  deux onglets ne lancent jamais deux chronos ; arrêter depuis deux onglets n'enregistre qu'une session.
- **Heure du serveur** pour le départ et l'arrêt : recharger, fermer le navigateur ou rouvrir le CRM le
  lendemain retrouve le bon temps. Les onglets ouverts se mettent à jour entre eux.
- À l'arrêt : confirmation dans la pastille et notification avec **Modifier**. Au-delà de 10 h, la notification
  propose de corriger l'heure de fin (chrono oublié).

## Page Temps

- S'ouvre sur **Cette semaine** (lundi → dimanche). Filtres : Aujourd'hui · Cette semaine · Ce mois-ci ·
  Période personnalisée (un an au plus).
- **Total** des sessions enregistrées, puis tableau trié par temps passé : client, répartition, temps, sessions.
  Un clic sur un client affiche ses sessions (date, libellé, durée, horaires).
- Le **chrono en cours** est affiché à part : il entre dans les totaux à l'arrêt.
- **Ajouter du temps** : client, date, durée (« 1h30 », « 45 min »…), libellé facultatif.
- **Modifier** une session (crayon) : client, libellé, début, fin ou durée ; **Supprimer**. Les totaux se
  mettent à jour aussitôt.

## Règles de calcul

- Fuseau **Europe/Paris** pour les dates, les jours et les filtres (changements d'heure compris).
- Une session ne compte, dans une période, que pour sa partie comprise dans la période : une session qui
  traverse minuit est répartie entre les deux jours.
- Une saisie manuelle est placée dans la journée choisie (à partir de 8 h, plus tôt si elle est longue).
- Une session dure 7 jours au plus ; la fin est toujours après le début.

## Accès

Réservé au propriétaire dans l'application : ni le portail client, ni un autre compte, ni le connecteur Claude
ne lisent ou n'écrivent le temps. Une fusion de fiches emporte le temps vers la fiche conservée.

Migration : `supabase/migrations/20261110000100_temps.sql` (additive).
