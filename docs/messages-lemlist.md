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

## Limites lemlist (documentation officielle)
- 20 requêtes par 2 secondes, par clé : un compte limité ne ralentit pas les autres.

## Environnement de test local
`npm run test-env` lance aussi un faux lemlist (`scripts/test-env/lemlist-fake.mjs`, 127.0.0.1) avec deux clés
fictives : `test-lemlist-alpha-0001` et `test-lemlist-beta-0002`. `POST /__revoke {"key": …}` simule une clé révoquée.
L'application ne s'adresse à ce faux lemlist que si `CELY_TEST_ENV=1` et que l'adresse est en 127.0.0.1 ; ailleurs,
c'est toujours `https://api.lemlist.com/api`. Une clé de chiffrement locale, tirée au hasard, remplace celle de `.env.local`.
