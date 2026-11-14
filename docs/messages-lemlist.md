# Messages lemlist (boîte de réception des comptes lemlist des clients)

Lire et répondre aux messages reçus sur les comptes lemlist des clients, depuis le CRM. Chantier en lots
(`feature/messages-lemlist`) : M1 connexion des comptes, M2 onglet Messages, M3 réponses, M4 non-lus.

## Comptes (M1)
- Paramètres › Connecteurs › **lemlist clients** › **Ajouter un compte** : fiche du client (vente gagnée) et clé API
  lemlist du client (lemlist › Réglages › Intégrations). Le CRM teste la clé (`GET /team`), affiche le nom de l'équipe
  et l'état **Connecté**.
- Une clé = un compte lemlist (une équipe). Un compte n'appartient qu'à une fiche ; une fiche peut en avoir plusieurs.
- Clé refusée par lemlist (invalide, révoquée, ou rattachée à une autre équipe) : ce compte seul passe
  **À reconnecter** ; on recolle une clé avec **Reconnecter**.
- **Déconnecter** efface la clé du CRM. Elle reste valable chez lemlist tant qu'elle n'y est pas supprimée.
- Fiche à la corbeille : compte caché et inutilisable, il revient à la restauration. Purge : compte et clé supprimés.
  Fusion : le compte suit la fiche conservée. Fiche archivée : le compte reste actif (mention « fiche archivée »).

## Onglet Messages (M2)
- Entrée **Messages** dans la navigation. Elle s'ouvre sur une **grille des clients actifs** (client ayant un compte
  lemlist Connecté ou À reconnecter) : nom du client et, s'il a de nouvelles réponses, une pastille rouge avec leur
  nombre (conversations non lues, même règle que le compteur du menu : la somme des pastilles lui est égale). Les cases
  avec de nouvelles réponses d'abord, puis par réponse la plus récente. Un compte à reconnecter garde sa case, avec cet état.
  Aucun client actif : renvoi vers Connecteurs.
- Clic sur une case (`/messages?client=…`) : à gauche les conversations de ce client, la plus récente en haut (contact,
  canal, point violet si non lu), filtres **Canal** et **Non lus** ; lien **Tous les clients** pour revenir à la grille.
  Ouvrir une conversation non lue fait baisser la pastille. Lien direct `/messages?conversation=…` : le serveur
  retrouve le client de la conversation et ouvre son fil.
  À droite, le fil complet, lu chez lemlist à l'ouverture (citations des réponses précédentes, images et suivi retirés ;
  texte seul, aucun HTML affiché).
- Lecture : pour chaque compte, `GET /team` puis `GET /inbox?userId=…` pour chaque membre de l'équipe (2 pages de 100
  au plus) ; une conversation suivie par deux membres n'apparaît qu'une fois. WhatsApp et SMS sont ignorés.
- Fil : `GET /inbox/{contactId}` lu deux fois et fusionné sans doublon — tel que l'équipe le voit, et tel que le voit
  le membre qui suit la conversation (`userId`) : les messages LinkedIn reçus arrivent par la synchronisation de la boîte
  LinkedIn de ce membre et manquaient sans cela. Jusqu'à 5 pages de 100 activités (messages anciens compris). Reçus :
  types finissant par `Replied`/`Received` (`emailsReplied`, `linkedinReplied`…) ; envoyés : `…Sent`. Un message
  échangé sans texte lisible est affiché quand même ; ouvertures, clics, invitations sont ignorés.
- Actualisation : à l'ouverture, puis toutes les 2 minutes tant que la page est visible, chaque compte au plus une fois
  par minute ; **Actualiser** relit tout de suite. Aucune tâche planifiée (la seule tâche Vercel tourne une fois par jour).
- Un compte limité en débit ou en panne est signalé par un bandeau ; ses conversations déjà connues restent affichées,
  les autres comptes sont actualisés normalement. Un compte « À reconnecter » n'est plus interrogé.
- Le CRM n'enregistre que : contact (nom, email), canaux, dates, état lu chez lemlist, date d'ouverture dans le CRM.
  Jamais le contenu des messages. Ces contacts ne deviennent ni fiches, ni contacts, ni prospects.
- **Non lu** : lemlist l'indique non lue ET elle n'a pas été ouverte dans le CRM depuis sa dernière activité. Ouvrir un
  fil dans le CRM ne le marque pas lu chez lemlist. Une réponse faite directement dans lemlist le marque lu chez lemlist :
  le non-lu disparaît au rafraîchissement suivant.

## Répondre (M3)
- Sous le fil : zone de réponse et bouton **Envoyer**. Au-dessus, « Envoi depuis : compte lemlist du client (équipe),
  expéditeur · par Email/LinkedIn ». Si la conversation a les deux canaux, on choisit le canal.
- Le serveur retrouve tout seul le compte (celui de la conversation) et l'expéditeur, en relisant le fil chez lemlist :
  - email : le membre de l'équipe et sa boîte mail qui ont écrit en dernier (`POST /inbox/email`), en réponse dans le
    même fil (`replyToActivityId` = dernier email) ;
  - LinkedIn : le membre qui a écrit en dernier et le lead du contact (`POST /inbox/linkedin`).
  Sans expéditeur identifiable, rien n'est envoyé : « répondez depuis lemlist ».
- La requête du navigateur ne contient que la conversation, le canal, le texte et une clé d'envoi ; tout champ en plus
  (identifiant de compte, clé…) fait refuser la requête.
- Un seul envoi par clé (double clic, requête rejouée). Échec certain : message, texte conservé, nouvel essai possible.
  lemlist ne répond pas : état **incertain** (jamais « envoyé »), texte conservé, « Renvoyer quand même » après
  confirmation. Clé refusée : le compte passe « À reconnecter ».
- Après l'envoi, la réponse apparaît dans le fil (relu chez lemlist ; en attendant, affichée « Envoyé depuis le CRM »).
- Seul l'état de chaque envoi est enregistré (`lemlist_replies`) : jamais le texte.

## Non-lus (M4)
- Compteur de non-lus sur **Messages** dans le menu (point sur « Plus » et nombre dans son panneau sur téléphone).
  Les compteurs du menu sont relus toutes les 5 minutes, page visible ; à cette occasion, les comptes lemlist lus il y a
  plus de 5 minutes sont relus (3 secondes au plus : une lenteur de lemlist ne retarde jamais les autres compteurs).
- **Aujourd'hui** : une ligne « N nouvelle(s) réponse(s) lemlist », N = le même nombre de non-lus que le menu et que la
  somme des pastilles de la grille. Lue au CRM : Aujourd'hui n'appelle pas lemlist. (`lemlist_counts` renvoie toujours
  aussi `awaiting`, qui n'est plus affiché.)

## Sécurité
- La clé est chiffrée par le serveur (AES-256-GCM, `src/lib/mail/crypto.ts`) avant d'être enregistrée, dans une table
  séparée (`lemlist_account_secrets`) que seule la fonction `lemlist_account_key` lit, pour un compte visible.
- Tous les appels à lemlist partent du serveur (`src/lib/lemlist/client.ts`). Le serveur retrouve la clé à partir de
  l'identifiant du compte ; aucune réponse ne renvoie la clé, même chiffrée ; les journaux n'écrivent que des codes.
- Accès réservé au propriétaire, imposé par la base (RLS) : ni le portail client, ni un autre compte, ni Claude (MCP).

## Variables d'environnement
- `MAIL_TOKEN_KEY` : déjà utilisée par Mail (32 octets en base64). Aucune nouvelle variable.

## Migrations
- `20261119000100_lemlist_comptes.sql` (additive).
- `20261119000200_lemlist_conversations.sql` (additive), à appliquer après la précédente.
- `20261119000300_lemlist_reponses.sql` (additive), à appliquer après la précédente.
- `20261119000400_lemlist_compteurs.sql` (additive), à appliquer après la précédente.
- `20261119000500_lemlist_messages_clients.sql` (additive : deux fonctions de lecture pour la grille par client), à appliquer après la précédente.

## Limites lemlist (documentation officielle)
- 20 requêtes par 2 secondes, par clé : un compte limité ne ralentit pas les autres.

## Environnement de test local
`npm run test-env` lance aussi un faux lemlist (`scripts/test-env/lemlist-fake.mjs`, 127.0.0.1) avec deux clés
fictives : `test-lemlist-alpha-0001` et `test-lemlist-beta-0002`. Il sert aussi des conversations
et messages fictifs (email, LinkedIn, un même contact chez les deux clients, une conversation WhatsApp ignorée).
Pilotage : `POST /__revoke {"key"}` (clé révoquée), `POST /__limit {"key"}` (débit dépassé),
`POST /__reply {"key", "contactId", "text", "channel"}` (nouvelle réponse du contact),
`POST /__sendfail {"key", "mode": "error" | "timeout" | "off"}` (envoi refusé ou sans réponse), `GET /__sent` (envois reçus).
L'application ne s'adresse à ce faux lemlist que si `CELY_TEST_ENV=1` et que l'adresse est en 127.0.0.1 ; ailleurs,
c'est toujours `https://api.lemlist.com/api`. Une clé de chiffrement locale, tirée au hasard, remplace celle de `.env.local`.
