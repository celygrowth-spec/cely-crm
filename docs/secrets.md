# Secrets serveur : usages et rotation (audit C12)

Aucun de ces secrets n'est envoyé au navigateur. Ils se règlent dans les variables d'environnement de l'hébergement.

## `APPOINTMENTS_SECRET` — secret serveur global
Malgré son nom, il protège plusieurs modules. Tout est **dérivé** de lui (HMAC avec un libellé distinct) :

| Usage dérivé | Sert à | Si le secret change |
| --- | --- | --- |
| clé serveur (`rpc`) | autoriser les fonctions publiques en base (réservation, portail, Fireflies, passages planifiés, Gmail serveur) ; seule son empreinte est en base | réenregistrée automatiquement à la première visite de Rendez-vous ou au premier « Lancer maintenant » (Paramètres › Passages planifiés) ; entre-temps, réservation, portail, Fireflies et passages planifiés sont refusés |
| jeton privé d'un rendez-vous (`manage`) | liens « annuler / reporter » envoyés aux invités | **tous les liens déjà envoyés deviennent invalides** (l'invité vous écrit ; le rendez-vous reste en base) |
| chiffrement du jeton Google Agenda (`enc`) | jeton de renouvellement de l'agenda | l'agenda doit être **reconnecté** (Paramètres › Connecteurs › Google Agenda) |
| empreintes du portail client | codes d'accès et sessions du portail | **tous les codes d'accès client sont à régénérer**, les sessions ouvertes sont fermées |

### Procédure de rotation (à faire seulement en cas de fuite)
1. Prévenir : les liens privés de rendez-vous et les codes du portail vont cesser de fonctionner.
2. Générer un nouveau secret : `openssl rand -base64 32`, le remplacer dans l'hébergement, redéployer.
3. Ouvrir Rendez-vous (la clé serveur est réenregistrée), puis Paramètres › Passages planifiés › « Lancer maintenant » :
   chaque tâche doit être « OK » ou « non active » avec sa raison.
4. Reconnecter Google Agenda.
5. Régénérer les codes du portail des clients actifs (Projets › Accès) et les leur transmettre.
6. Vérifier : une réservation de test sur la page publique (adresse `example.test`), une connexion au portail avec un
   nouveau code, un import Fireflies (le webhook utilise son propre secret, voir ci-dessous).

Une séparation en secrets distincts (un par usage) est possible plus tard, avec une transition vérifiable : accepter
l'ancien et le nouveau pendant une période, puis retirer l'ancien. Elle n'est pas faite ici (risque de casser liens et
codes existants sans bénéfice immédiat).

## Autres secrets
| Variable | Usage | Rotation |
| --- | --- | --- |
| `MAIL_TOKEN_KEY` | chiffre les jetons Gmail en base | change → reconnecter Gmail |
| `CRON_SECRET` | autorise les passages planifiés (`/api/cron`, `/api/fireflies/cron`, `/api/rendez-vous/reconcile`) | changer aussi dans le planificateur Supabase (Vault) s'il est activé |
| `FIREFLIES_WEBHOOK_SECRET` | signature HMAC des webhooks Fireflies (mécanisme officiel `x-hub-signature`) ; un webhook rejoué est sans effet (import par identifiant de réunion) | changer aussi dans Fireflies |
| `FIREFLIES_API_KEY` | lecture des appels | retirer la clé = plus aucun import futur ; les appels déjà importés restent |
| `GOOGLE_*_CLIENT_SECRET` | OAuth Google (agenda, Gmail) | changer dans Google Cloud puis dans l'hébergement |
| `APP_URL` | adresse publique de l'application : retours OAuth et liens, jamais déduits d'un en-tête de requête | — |
