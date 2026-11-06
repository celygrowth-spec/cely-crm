# Fireflies : import automatique des appels

État : **phase 1 (import)** livrée sur `feature/fireflies-crm`. Le rattachement aux fiches (phase 2) et
l'onglet « Historique des appels » (phase 3) viennent ensuite. Tant qu'ils n'existent pas, les appels sont
enregistrés en base mais ne s'affichent sur aucune fiche.

## Comment ça marche

1. Fireflies prévient le CRM (`POST /api/fireflies/webhook`) quand une transcription ou un résumé est prêt.
2. Le CRM vérifie la signature, enregistre la tâche en base, **puis** répond. Si l'enregistrement échoue, il
   répond 503 et Fireflies réessaie (5 fois, jusqu'à 2 h d'écart).
3. Juste après la réponse, le serveur interroge l'API Fireflies et enregistre en une seule fois l'appel, sa
   transcription complète et la fin de la tâche.
4. Une fois par jour, entre 5 h et 6 h UTC, un passage planifié (`/api/fireflies/cron`) relance ce qui est en
   attente et rattrape les appels des 3 derniers jours dont le webhook se serait perdu.

| État affiché | Signification |
| --- | --- |
| En cours d'import | Tâche enregistrée, appel pas encore récupéré (y compris pendant une reprise) |
| Résumé en attente | Appel et transcription enregistrés, résumé pas encore prêt chez Fireflies |
| Importé | Terminé. Sans résumé si Fireflies n'en produit pas (appel silencieux, résumé en échec, ou aucun résumé après 7 jours) |
| Échec | Abandon : erreur définitive, ou 8 tentatives infructueuses. Relançable |

Règles qui évitent les doublons et les pertes :

- Un appel est unique par compte Fireflies et identifiant Fireflies, et une réunion n'a qu'une seule tâche.
- Un événement déjà vu ne coûte aucune requête. Un renvoi avec un `reprocessed_at` plus récent reprend l'appel ;
  un `reprocessed_at` égal ou plus ancien est ignoré.
- Un événement reçu pendant un traitement relance un passage ensuite.
- Une réponse sans résumé ou sans ligne n'efface jamais ce qui est déjà enregistré.

## Configuration, étape par étape

Les valeurs secrètes se saisissent uniquement dans Vercel et dans Fireflies, jamais dans une conversation ni
dans le code.

**Avant de commencer** : la migration doit être appliquée et l'application déployée en production. L'adresse
du webhook doit répondre sans protection : une préversion Vercel protégée renverrait une page de connexion à
Fireflies.

1. **Migration** : dans Supabase › SQL Editor, coller et exécuter le contenu de
   `supabase/migrations/20261108000100_fireflies.sql`. Le module Rendez-vous doit déjà être installé.
2. **Clé API** : dans Fireflies › Integrations › Fireflies API, copier la clé. Dans Vercel › projet › Settings ›
   Environment Variables, créer `FIREFLIES_API_KEY` avec cette valeur.
3. **Secret de signature** : dans un terminal, lancer `openssl rand -hex 32`. Dans Vercel, créer
   `FIREFLIES_WEBHOOK_SECRET` avec le résultat. Garder la valeur sous la main pour l'étape 6.
4. **Secrets existants** : vérifier dans Vercel que `APPOINTMENTS_SECRET` (Rendez-vous) existe. Créer
   `CRON_SECRET` s'il manque (`openssl rand -hex 32`). Vercel le transmet tout seul au passage quotidien.
5. **Déploiement** : redéployer pour que les variables soient prises en compte. Ouvrir une fois la page
   Rendez-vous, ou `/api/fireflies/status`, connecté avec votre compte : cela enregistre la clé serveur si besoin.
6. **Webhook** : sur https://app.fireflies.ai/integrations/api/webhook :
   - URL : `https://<adresse de production du CRM>/api/fireflies/webhook`
   - Signing secret : la valeur de l'étape 3
   - Événements : cocher `meeting.transcribed` et `meeting.summarized`
   - Activer « Resend when a meeting's notes change »
   - Enregistrer
7. **Contrôle** : cliquer « Send Test Event », puis ouvrir `/api/fireflies/status`. `last_webhook_at` doit être
   renseigné. Si l'événement de test porte un identifiant fictif, il apparaîtra en `failed`
   (`object_not_found`) : c'est sans conséquence. Le format exact de cet événement reste à observer.
8. **Vrai test** : passer un court appel de test avec Fireflies, vérifier dans `/api/fireflies/status` que
   l'état devient `imported`, et comparer la dernière phrase à celle de Fireflies.

## Limites à connaître

**Forfait Fireflies** (doc consultée le 6 novembre 2026)

| Forfait | Par minute | Par jour |
| --- | --- | --- |
| Free | 30 | 500 |
| Pro | 60 | 5 000 |
| Business | 60 par siège (max 1 200) | illimité |
| Enterprise | 60 par siège (max 2 400) | illimité |

Le CRM utilise une requête par import, plus une page de liste par jour pour 50 appels. La documentation
n'indique pas de forfait minimal pour les webhooks V2 ni pour les champs de résumé : à **vérifier sur votre
compte** à l'étape 6. Les webhooks ne couvrent que les réunions dont vous êtes propriétaire (l'équipe entière
demande le forfait Enterprise et le rôle Super Admin).

**Si le webhook n'est pas disponible** : rien à changer. Le passage quotidien importe tout seul les appels des
3 derniers jours, avec un délai pouvant atteindre 24 h.

**Vercel Hobby** : la tâche planifiée stable ne peut tourner qu'une fois par jour, avec une heure de marge. Le
fonctionnement normal n'en dépend pas, car le traitement part dès le webhook. En revanche, après une panne plus
longue que les reprises immédiates, la reprise peut attendre le webhook suivant ou le passage du lendemain.
Vercel Schedules (bêta, toutes les 15 minutes sur Hobby) pourrait réduire ce délai : non retenu tant qu'il est
en bêta. Un service externe peut aussi appeler `/api/fireflies/cron` avec `Authorization: Bearer <CRON_SECRET>`.

## Droits et confidentialité

- `FIREFLIES_API_KEY` et `FIREFLIES_WEBHOOK_SECRET` restent côté serveur.
- Lecture des tables réservée au propriétaire dans l'application. Le rôle anon (portail client, visiteurs),
  un autre compte et le connecteur Claude n'y ont aucun accès. C'est testé sur les vraies migrations.
- La clé serveur écrit des imports, mais aucune de ces fonctions ne rend de résumé ni de transcription.
- Les journaux contiennent l'identifiant de tâche et un code d'erreur, jamais de contenu. Les messages d'erreur
  enregistrés sont ceux du CRM, pas ceux de Fireflies.
- Les réponses Fireflies sont du contenu non fiable : seul un lien `https` vers `fireflies.ai` est conservé,
  contrôlé dans le serveur et en base. L'affichage (phase 3) devra les traiter en texte simple.

## Points à confirmer sur un appel réel

Ces points ne sont pas précisés par la documentation et n'ont été testés qu'avec un Fireflies simulé :

- l'unité de `start_time` et `end_time` (typés « chaîne », supposés en secondes) ;
- la forme exacte des erreurs GraphQL et de l'événement de test ;
- la présence du résumé selon le forfait.

## Raccordements prévus, sans dépendance de branche

- **Rendez-vous (phase 2)** : `fireflies_calls.calendar_event_id` et `meeting_link` serviront à reconnaître un
  rendez-vous, à recouper avec l'horaire et les participants.
- **Mail** : le module pourra lire l'adresse des participants dans `fireflies_calls.participants`. La liste de
  vos propres adresses à ignorer en phase 2 pourra inclure `mail_accounts` lorsque ce module est présent, sans
  que l'import en dépende.
- **Portail client** : aucun raccordement. Le portail passe par le rôle anon et ses propres fonctions, sans
  droit sur ces tables. Ne jamais y ajouter de fonction rendant un résumé, un lien ou une transcription.
