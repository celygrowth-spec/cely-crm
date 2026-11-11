# Fireflies : import automatique des appels

État : **phases 1 (import), 2 (rattachement) et 3 (historique)** livrées sur `feature/fireflies-crm`. Le parcours
complet reste à vérifier sur un appel réel, une fois la configuration faite.

## Où retrouver un appel

- **Sur la fiche, onglet « Activité », filtre « Appels »**, plus récents en premier : titre, date, durée, principaux
  participants, aperçu de la description, bouton « Ouvrir dans Fireflies ». La section se charge à part et
  n'alourdit pas l'ouverture de la fiche. Le résumé arrive avec la liste.
- **Au clic, le panneau de détail** : « Description de l'appel » (résumé, prochaines actions, points clés, ou l'état
  si le résumé manque), note interne, rattachement, puis « Transcription complète », chargée seulement à ce moment.
  Fireflies n'a pas de champ « décisions » : elles apparaissent dans le résumé et les points clés.
- **Dans la transcription** : 200 lignes s'affichent d'abord, puis la suite en défilant ou avec « Tout afficher ». La
  recherche (sans tenir compte des accents ni des majuscules) et « Copier la transcription » portent toujours sur
  le texte complet.
- **Depuis un rendez-vous** : section « Compte rendu de l'appel » du détail. Depuis l'appel : « Voir le rendez-vous ».
- **Menu Appels › Appels à rattacher** : candidates, autre fiche, ignorer, recalculer, appels ignorés.
- **Menu Appels › Suivi Fireflies** : dernière synchro, configuration, imports en échec et relance, import d'une
  période passée, vos autres adresses.

**Import d'une période passée** : un an au maximum. Les réunions déjà connues ne sont pas reprises et vos choix
restent. Les appels sont mis en file, puis « Traiter maintenant » les importe, écran ouvert. Sans cela, le
passage quotidien n'en traite qu'une partie (environ 30 secondes par jour).

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

## Rattachement à une fiche

À chaque import, dans la même transaction que l'appel, les règles s'appliquent dans cet ordre :

1. **Rendez-vous du CRM déjà rattaché à une fiche.** Reconnu par l'identifiant d'événement Google (`cal_id`), qui
   ne change pas après un report. Sinon, il faut l'horaire (de 30 min avant à 30 min après le rendez-vous) **et**
   l'email de l'invité parmi les participants. Un lien Meet seul ne suffit jamais, il ne sert qu'à départager
   deux rendez-vous possibles.
2. **Email exact d'un participant externe connu**, si les contacts désignent une seule entreprise.
3. **Sinon, « Appels à rattacher »**, avec jusqu'à 10 fiches candidates et leurs raisons : contact, candidate du
   rendez-vous, domaine du site ou d'un contact, même nom de personne, nom de l'entreprise dans le titre. Ces
   indices aident à trouver la fiche, ils ne rattachent jamais seuls.

**Adresses ignorées** : celle de votre compte, vos boîtes Mail, votre agenda Google, le compte Fireflies, celles
ajoutées avec `fireflies_set_own_addresses`, tout le domaine d'une de ces adresses s'il est professionnel, ainsi
que les comptes techniques (enregistreurs de réunion, salles d'agenda, `noreply`, etc.).

**Vos choix sont conservés.** Rattacher, déplacer ou ignorer verrouille l'appel : ni un nouvel import ni le
recalcul n'y touchent. « Annuler mon choix » le rend aux règles automatiques. Sans choix de votre part, chaque
import réapplique les règles.

**Jamais de création** : un appel ne crée ni entreprise, ni contact, ni opportunité.

**Mise à jour des appels à rattacher** : le passage quotidien (ou `POST /api/fireflies/rematch`) les reprend, car
un contact ajouté depuis peut maintenant les désigner.

**Une seule activité par appel** sur la fiche, avec le texte fixe « Appel enregistré par Fireflies », sans titre,
résumé ni lien. Elle compte comme dernier échange et suit l'appel s'il est déplacé.

- Si « Rendez-vous réalisé » existe déjà, cette activité est réutilisée. Elle reste sur la fiche du rendez-vous
  si l'appel part ailleurs.
- Si l'appel arrive d'abord, qualifier le rendez-vous n'ajoute pas de seconde activité.

**Fusion de fiches** : les appels et vos choix suivent la fiche conservée. **Fiche supprimée** : l'appel revient
dans la file avec sa transcription.

**Du rendez-vous à l'appel** : `fireflies_calls.booking_id` relie les deux.

| Route (propriétaire uniquement) | Rôle |
| --- | --- |
| `GET /api/fireflies/to-link` | File à rattacher, sans résumé ni transcription |
| `POST /api/fireflies/calls/<id>/link` | `{"action":"link","company_id":…}`, `{"action":"ignore"}` ou `{"action":"reset"}` |
| `POST /api/fireflies/rematch` | Recalcule les appels à rattacher |

## Configuration, étape par étape

Les valeurs secrètes se saisissent uniquement dans Vercel et dans Fireflies, jamais dans une conversation ni
dans le code.

**Avant de commencer** : la migration doit être appliquée et l'application déployée en production. L'adresse
du webhook doit répondre sans protection : une préversion Vercel protégée renverrait une page de connexion à
Fireflies.

1. **Migrations** : dans Supabase › SQL Editor, coller et exécuter, dans cet ordre, le contenu de
   `supabase/migrations/20261108000150_fireflies.sql`, `20261108000200_fireflies_rattachement.sql` puis
   `20261108000300_fireflies_historique.sql`. Les modules Rendez-vous et Mail doivent déjà être installés.
2. **Clé API** : dans Fireflies › Integrations › Fireflies API, copier la clé. Dans Vercel › projet › Settings ›
   Environment Variables, créer `FIREFLIES_API_KEY` avec cette valeur.
3. **Secret de signature** : dans un terminal, lancer `openssl rand -hex 32`. Dans Vercel, créer
   `FIREFLIES_WEBHOOK_SECRET` avec le résultat. Garder la valeur sous la main pour l'étape 6.
4. **Secrets existants** : vérifier dans Vercel que `APPOINTMENTS_SECRET` (Rendez-vous) existe. Créer
   `CRON_SECRET` s'il manque (`openssl rand -hex 32`). Vercel le transmet tout seul au passage quotidien.
5. **Déploiement** : redéployer pour que les variables soient prises en compte. Ouvrir une fois **Appels › Suivi
   Fireflies**, connecté avec votre compte : cela enregistre la clé serveur si besoin. Les quatre lignes de
   configuration doivent être cochées.
6. **Webhook** : sur https://app.fireflies.ai/integrations/api/webhook :
   - URL : `https://<adresse de production du CRM>/api/fireflies/webhook`
   - Signing secret : la valeur de l'étape 3
   - Événements : cocher `meeting.transcribed` et `meeting.summarized`
   - Activer « Resend when a meeting's notes change »
   - Enregistrer
7. **Contrôle** : cliquer « Send Test Event », puis ouvrir **Appels › Suivi Fireflies**. « Dernier webhook reçu »
   doit être renseigné. Si l'événement de test porte un identifiant fictif, il apparaîtra dans les imports en échec :
   c'est sans conséquence. Le format exact de cet événement reste à observer.
8. **Vrai test** : passer un court appel de test avec Fireflies, le retrouver sur la fiche (ou dans Appels à
   rattacher), l'ouvrir, et comparer la dernière phrase à celle de Fireflies.

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
  contrôlé dans le serveur et en base. Titres, résumés et transcriptions s'affichent comme du texte simple,
  jamais comme du HTML.

## Points à confirmer sur un appel réel

Ces points ne sont pas précisés par la documentation et n'ont été testés qu'avec un Fireflies simulé :

- l'unité de `start_time` et `end_time` (typés « chaîne », supposés en secondes) ;
- la forme exacte des erreurs GraphQL et de l'événement de test ;
- la présence du résumé selon le forfait et la mise en forme réelle de ses champs ;
- que `cal_id` correspond bien au `google_event_id` enregistré par Rendez-vous : la documentation l'indique, mais
  Google Agenda n'est pas encore vérifié de bout en bout. Sinon, la règle horaire + participant prend le relais ;
- que les fonctions lisent bien `auth.users` sur Supabase (pour votre adresse). En cas de refus, l'appel reste
  enregistré, mais à rattacher.

## Raccordements prévus, sans dépendance de branche

- **Rendez-vous** : `fireflies_calls.booking_id` relie l'appel au rendez-vous. La lecture de `appt_bookings` suffit.
- **Mail** : `mail_accounts`, déjà dans `main`, alimente vos adresses à ignorer. Le module Mail pourra lire
  `fireflies_calls.participants`, sans dépendance de sa branche.
- **Portail client** : aucun raccordement. Le portail passe par le rôle anon et ses propres fonctions, sans
  droit sur ces tables. Ne jamais y ajouter de fonction rendant un résumé, un lien ou une transcription.
