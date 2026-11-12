# Passages planifiés (agenda, rappels, réception Gmail, Fireflies)

Une seule route : `GET|POST /api/cron` (paramètre facultatif `?taches=agenda,rappels,gmail,fireflies,corbeille`).
Autorisée par `Authorization: Bearer <CRON_SECRET>` (planificateur) ou par la session du propriétaire
(bouton « Lancer maintenant » dans Paramètres › Passages planifiés). Chaque tâche est isolée : une erreur n'empêche
pas les suivantes. Dernière réussite et dernière erreur sont enregistrées (`scheduled_jobs`) et affichées.

| Tâche | Ce qu'elle fait |
| --- | --- |
| agenda | Répercute dans Google les annulations, reports et modifications enregistrés au CRM (la base fait foi), puis signale les déplacements faits directement dans Google |
| rappels | Envoie par Gmail les rappels dus (20 par passage au plus), après avoir vérifié la version du rendez-vous et la révision du rappel. Un résultat incertain n'est jamais renvoyé. Suspension globale : Rendez-vous › réglages des rappels |
| gmail | Lit les emails reçus (initial : 30 jours, 150 messages ; ensuite incrémental) et rattache les réponses des contacts |
| fireflies | Rattrape les appels manqués par le webhook |
| corbeille | Supprime définitivement les éléments à la corbeille depuis 30 jours et retire leurs fichiers du stockage (voir `docs/corbeille.md`) |

## Fréquence
- **Vercel (offre Hobby, actuelle)** : une tâche planifiée par jour au plus. `vercel.json` lance `/api/cron` chaque
  jour à 5 h UTC. C'est suffisant pour l'agenda, Gmail et Fireflies en rattrapage, **pas pour les rappels** (un rappel
  dû n'est envoyé que dans les 15 minutes qui suivent son échéance ; au-delà il est abandonné, jamais envoyé en retard).
- **Recommandé : planificateur Supabase (pg_cron + pg_net), toutes les 15 minutes**, disponible sur toutes les offres
  Supabase. À activer par vous (production) : `supabase/maintenance/planificateur.sql` (remplacez l'URL et le secret).
- Offre Vercel Pro : on peut aussi passer le `schedule` de `vercel.json` à `*/15 * * * *`.

## Variables nécessaires
`CRON_SECRET` (au moins 16 caractères), plus celles de Google Agenda, Gmail (`GOOGLE_MAIL_CLIENT_ID`,
`GOOGLE_MAIL_CLIENT_SECRET`, `MAIL_TOKEN_KEY`) et Fireflies selon les tâches utilisées.
