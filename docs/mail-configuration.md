# Configurer Gmail pour le CRM

Sources vérifiées le 5 novembre 2026 sur les documentations officielles Google. Google peut faire évoluer ces règles.

## 1. Projet Google Cloud

1. Sur [console.cloud.google.com](https://console.cloud.google.com), créez un projet (ou réutilisez celui du CRM).
2. **API et services › Bibliothèque** : activez **Gmail API**.
3. **Google Auth Platform › Présentation** : renseignez le nom de l'application et votre email.
4. **Audience** (type d'utilisateurs) :
   - **Interne** si l'adresse est sur Google Workspace : réservé à votre organisation.
   - **Externe** pour un compte Gmail personnel. Ajoutez votre adresse dans les **utilisateurs test**.
5. **Accès aux données** : ajoutez `https://www.googleapis.com/auth/gmail.send`.
6. **Clients › Créer un client** : type **Application Web**, nommé par exemple « Cely CRM Mail ».
   URI de redirection autorisés :
   - `http://localhost:3000/api/mail/oauth/callback`
   - `https://cely-crm.vercel.app/api/mail/oauth/callback`

   Les adresses de préversion Vercel changent à chaque déploiement : la connexion n'y fonctionne pas.

**Utilisez un client dédié au mail, distinct de celui de Google Calendar.** Révoquer une autorisation retire toutes les
autorisations de ce client : avec un client commun, déconnecter Gmail couperait aussi Calendar.

## 2. Mode test et publication

| Situation | Conséquence |
|---|---|
| Externe, statut **Test** | Le jeton de renouvellement **expire après 7 jours** : le CRM affiche « À reconnecter » chaque semaine. Suffisant pour essayer. |
| Externe, statut **En production**, non vérifié | Pas d'expiration à 7 jours. Pour un usage personnel (moins de 100 utilisateurs), la vérification n'est pas obligatoire : vous passez l'écran d'avertissement « application non vérifiée » à la connexion. **Recommandé pour un compte Gmail personnel.** |
| Interne (Workspace) | Sans vérification ni avertissement, pour les membres de votre organisation. Le projet doit appartenir à l'organisation. **Recommandé si votre adresse est sur Workspace.** |

Niveau des autorisations :

- `gmail.send` (phase 1) : **sensible**. La vérification Google concerne une application publique.
- `gmail.readonly` (phase 2) : **restreinte**, avec des exigences plus fortes si l'application devenait publique.
  Elle sera demandée seulement à la phase 2, avec une explication à l'écran.

## 3. Variables d'environnement

À renseigner dans `.env.local` en local et dans Vercel (Settings › Environment Variables) :

| Variable | Valeur |
|---|---|
| `GOOGLE_MAIL_CLIENT_ID` | Identifiant du client créé ci-dessus |
| `GOOGLE_MAIL_CLIENT_SECRET` | Secret du client |
| `MAIL_TOKEN_KEY` | Résultat de `openssl rand -base64 32` |

Ces valeurs ne vont jamais dans Git ni dans le navigateur. Gardez la même `MAIL_TOKEN_KEY` : la changer rend les jetons
illisibles et oblige à reconnecter Gmail.

## 4. Base de données

Appliquez `supabase/migrations/20261106000100_mail.sql` dans le SQL Editor. Cette migration ajoute des tables et des
fonctions : elle ne modifie aucune table existante, à part un déclencheur de fusion sur `companies`.

## 5. Vérifier

Page **Mail** › **Connecter Gmail** › **Envoyer le test** vers une adresse à vous, puis vérifiez la réception.

## Sécurité

- Aucun mot de passe Gmail : l'identification se fait chez Google.
- Jetons chiffrés (AES-256-GCM) dans `mail_account_secrets`, avec une clé qui reste côté serveur.
- Accès réservé au propriétaire par RLS. Le connecteur Claude n'a accès ni aux jetons, ni aux messages, ni à l'envoi.
- Déconnexion : les jetons sont effacés, les envois s'arrêtent, l'accès est révoqué chez Google, et les messages
  en attente sont annulés sans repartir à la reconnexion.

## Limites d'envoi

Google Workspace : 2 000 messages par jour et par utilisateur, 500 sur un compte d'essai. La limite dépassée bloque
l'envoi jusqu'à 24 h, et le CRM affiche alors un échec « Limite d'envoi Gmail atteinte ». Les limites d'un compte Gmail
personnel sont plus basses : consultez l'aide Google.
