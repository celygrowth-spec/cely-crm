# Rendez-vous — configuration externe (Google Calendar, secrets)

Le module Rendez-vous fonctionne **sans Google** (créneaux calculés à partir de vos disponibilités et des
rendez-vous enregistrés). Google Calendar ajoute la vérification de vos occupations et la création des
événements. Rien n'est simulé : tant qu'une variable manque, la fonction concernée est désactivée et
l'écran « Paramètres › Connecteurs › Google Agenda » l'indique.

## 1. Variables d'environnement (Vercel › Settings › Environment Variables, et `.env.local`)

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `APPOINTMENTS_SECRET` | oui | Secret serveur (≥ 32 caractères). Dérive la clé qui ouvre les fonctions publiques en base, les jetons des liens privés d'annulation/report et la clé de chiffrement du jeton Google. Générer : `openssl rand -base64 48`. **Le changer invalide les liens privés déjà envoyés et oblige à reconnecter Google.** |
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | pour Google | Client OAuth « Application Web ». À défaut, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` sont utilisés (client partagé avec le module Mail). |
| `APP_URL` | conseillé | URL publique, ex. `https://cely-crm.vercel.app` (liens privés, retour OAuth). Sinon : origine de la requête. |
| `CRON_SECRET` | facultatif | Autorise `GET /api/rendez-vous/reconcile` depuis une tâche planifiée (Vercel Cron envoie `Authorization: Bearer CRON_SECRET`). |

Aucune clé `service_role` n'est nécessaire.

Après déploiement, **ouvrez une fois l'espace « Rendez-vous »** connecté avec le compte propriétaire :
l'application enregistre en base l'empreinte de la clé serveur. Avant cela, les pages publiques
affichent « Réservation momentanément indisponible ».

## 2. Base Supabase

Appliquer la migration `supabase/migrations/20261105120000_rendez_vous.sql` (ou `supabase/install.sql`
régénéré par `npm run db:bundle` sur un projet vide). Elle est additive et requiert l'extension
`btree_gist` (disponible sur Supabase, créée dans le schéma `extensions`).

## 3. Projet Google Cloud

Le même projet que la connexion Gmail du module Mail peut servir ; les deux connexions restent
**indépendantes** (jetons, écrans, route de retour distincts).

1. console.cloud.google.com › APIs & Services › **Library** › activer **Google Calendar API**.
2. **OAuth consent screen** : type *External* (ou *Internal* pour Google Workspace), ajouter les portées :
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` — liste des agendas ;
   - `https://www.googleapis.com/auth/calendar.freebusy` — plages occupées uniquement (pas le contenu) ;
   - `https://www.googleapis.com/auth/calendar.events.owned` — événements des rendez-vous sur vos agendas.
3. **Credentials › Create credentials › OAuth client ID › Web application**, *Authorized redirect URIs* :
   - `https://<votre-app>/api/rendez-vous/google/callback`
   - `http://localhost:3000/api/rendez-vous/google/callback` (développement)
4. Mode *Testing* : ajoutez votre adresse comme *test user*. Attention, en mode *Testing* Google expire
   les jetons de rafraîchissement après 7 jours : passez l'application en *In production* (pour un usage
   personnel, l'écran « application non vérifiée » peut être accepté ; `calendar.events.owned` est une
   portée sensible).
5. Dans Cely : Paramètres › Connecteurs › Google Agenda › **Connecter Google Agenda**, puis choisir les agendas
   à vérifier et l'agenda de destination.

### Interaction avec le module Mail (Gmail)

- Route de retour propre au module : `/api/rendez-vous/google/callback` ; cookies limités à
  `/api/rendez-vous/google`.
- `include_granted_scopes` n'est pas utilisé : le jeton Agenda ne reçoit jamais les portées Gmail et
  inversement. Révoquer l'un ne révoque pas l'autre.
- Si le module Mail met en place un gestionnaire OAuth Google partagé, la connexion Agenda pourra s'y
  raccorder : tout passe par `src/lib/appointments/google.ts` (échange de code, rafraîchissement) et
  la table `appt_google_connection`. À décider ensemble, sans remplacement silencieux.

## 4. Fiabilité et limites connues

- **Agenda injoignable** : si un agenda connecté ne répond pas, la page publique n'affiche aucun créneau
  et refuse les réservations (jamais « libre » par défaut).
- **Confirmation** : avec un agenda de destination, le rendez-vous n'est confirmé qu'après création de
  l'événement Google (identifiant déterministe : une nouvelle tentative ne crée pas de doublon). En cas
  d'échec, le créneau est libéré et l'événement éventuellement créé est supprimé.
- **Reprise** : toute divergence (annulation ou report non répercuté) est reprise automatiquement
  à chaque réservation, depuis « Paramètres › Connecteurs › Google Agenda › Relancer maintenant », ou par tâche planifiée sur
  `/api/rendez-vous/reconcile`. La base fait foi.
- **Sens unique** : un événement déplacé ou supprimé directement dans Google n'est pas reporté dans Cely ;
  le créneau reste réservé. Reporter/annuler depuis Cely.
- **Battements cumulés** : chaque rendez-vous occupe `[début − battement avant, fin + battement après]` ;
  deux occupations ne peuvent pas se chevaucher (contrainte en base).
- Les occupations Google sont soustraites des événements créés par l'outil (déjà comptés en base). Cas
  marginal : un événement externe exactement superposé à un rendez-vous en cours de report peut être ignoré
  pour ce seul report.
- **Emails** : aucun email n'est envoyé par ce module (ni confirmation, ni rappel) ; voir
  `docs/integrations/appointments-mail.md`. Google n'envoie pas d'invitation (`sendUpdates=none`).
