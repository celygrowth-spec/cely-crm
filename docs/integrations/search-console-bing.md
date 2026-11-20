# Google Search Console et Bing Webmaster Tools

Deux connecteurs **en lecture seule** dans Paramètres › Connecteurs. Ils importent le référencement du site
(clics, impressions, position moyenne ; le taux de clic se calcule) dans la table `seo_daily`, par jour, par page et
par requête. Le CRM n'écrit jamais rien chez Google ni chez Bing.

## Variables d'environnement (noms uniquement)

| Variable | Rôle |
| --- | --- |
| `GOOGLE_SEARCH_CONSOLE_CLIENT_ID` | Client OAuth Google dédié à Search Console (facultatif) |
| `GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET` | Secret de ce client (facultatif) |
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | Utilisés si les deux précédentes sont absentes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Dernier recours, comme pour Google Agenda |
| `APPOINTMENTS_SECRET` | Obligatoire : chiffre le jeton Google et la clé Bing avant leur écriture en base, et autorise le passage planifié |
| `APP_URL` | Adresse publique de l'application (retour OAuth) |
| `CRON_SECRET` | Passage quotidien (`/api/cron`) |

Aucune variable pour Bing : la clé API se colle dans l'application.

Les valeurs se règlent chez l'hébergeur. N'écrivez jamais une valeur dans le dépôt, un ticket ou une conversation.

## Google Search Console

### Dans Google Cloud (une fois)
1. Ouvrez le projet Google Cloud qui porte le client OAuth (celui de Google Agenda convient, ou un projet dédié).
2. **API et services › Bibliothèque** : activez **Google Search Console API**.
3. **Écran de consentement OAuth › Accès aux données** : ajoutez la portée
   `https://www.googleapis.com/auth/webmasters.readonly` (lecture seule). C'est la seule portée demandée.
4. **Identifiants › votre client OAuth (application Web) › URI de redirection autorisés** : ajoutez
   `<APP_URL>/api/tracking/seo/google/callback` (par exemple l'adresse de production suivie de ce chemin).
5. Si vous créez un client dédié, renseignez `GOOGLE_SEARCH_CONSOLE_CLIENT_ID` et
   `GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET` chez l'hébergeur, puis redéployez.

### Dans le CRM
1. Paramètres › Connecteurs › **Google Search Console** › **Connecter**, avec le compte Google qui voit la propriété
   du site dans Search Console.
2. Si le compte voit plusieurs propriétés, choisissez celle du site (propriété de domaine `sc-domain:…` de
   préférence : elle couvre toutes les variantes d'adresse). Avec une seule propriété, elle est retenue d'office.
3. **Synchroniser maintenant** lance l'import ; le bouton enchaîne les lots jusqu'à la fin de l'historique. Vous pouvez
   fermer la page : le passage quotidien reprend là où l'import s'est arrêté.

Changer de propriété efface les chiffres importés de l'ancienne et relance l'import.

### Client OAuth partagé et déconnexion
« Déconnecter » efface le jeton du CRM. Le jeton n'est révoqué chez Google que si Search Console a **son propre**
client OAuth : avec un client partagé (Agenda, Gmail), la révocation pourrait couper aussi ces connexions. Pour
retirer l'autorisation dans ce cas : compte Google › Sécurité › Accès tiers.

## Bing Webmaster Tools

1. Connectez-vous à [Bing Webmaster Tools](https://www.bing.com/webmasters) ; le site doit y être ajouté et vérifié.
2. **Paramètres (roue dentée) › Accès API › Clé API › Générer**. Une seule clé par utilisateur ; elle vaut pour tous
   ses sites vérifiés.
3. Dans le CRM : Paramètres › Connecteurs › **Bing Webmaster Tools** : collez la clé et l'adresse du site telle
   qu'elle figure dans Bing (par exemple `https://exemple.com/`), puis **Connecter Bing**. La clé est essayée en
   lecture, chiffrée, puis n'est plus jamais affichée.

Pour retirer l'accès : « Déconnecter » dans le CRM, puis supprimez la clé dans Bing (Accès API › Supprimer) si elle
ne sert plus. Pour la remplacer : générez-en une nouvelle et collez-la dans le même formulaire.

### Ce que Bing fournit réellement
L'API de Bing n'accepte pas de dates : chaque appel rend tout l'historique que Bing conserve.

| Appel | Contenu | Rangé dans `seo_daily` |
| --- | --- | --- |
| `GetRankAndTrafficStats` | Clics et impressions du site par jour, sans position (mis à jour chaque jour) | `page = ''`, `query = ''` |
| `GetQueryStats` | Requêtes principales, par date (mis à jour chaque semaine) | `page = ''` |
| `GetPageStats` | Pages principales, par date (mis à jour chaque semaine) | `query = ''` |
| `GetPageQueryStats` | Requêtes d'une page, par date : un appel par page, 200 pages au plus | page et requête |

Limites : pas de longue traîne (requêtes et pages « principales » seulement) ; la documentation de Microsoft ne
précise ni la profondeur de l'historique ni le pas des dates des statistiques hebdomadaires (les lignes sont rangées
telles que Bing les date) ; la position est la position moyenne à l'affichage (`AvgImpressionPosition`).

## Lire `seo_daily`

Une ligne par `(provider, day, page, query)` :
- `page` et `query` renseignées : croisement page × requête ;
- `page = ''` : total d'une requête ; `query = ''` : total d'une page ; les deux vides : total du site.

Search Console n'écrit que des croisements (les requêtes anonymisées par Google n'y figurent pas : la somme est
inférieure au total affiché dans Search Console). Bing écrit les quatre niveaux. **Ne jamais additionner des niveaux
différents** : filtrer d'abord sur le niveau voulu.

`page` est un chemin (`/services`) : sans domaine, sans paramètres, sans barre finale. Deux adresses qui donnent le
même chemin sont additionnées (position pondérée par les impressions).

## Synchronisation

- Passage planifié `seo` (dernier de `/api/cron`, visible dans Paramètres › Passages planifiés), et bouton
  « Synchroniser maintenant ».
- **Search Console** : une requête par jour de données. À chaque passage, les 4 derniers jours sont relus (les 3
  derniers sont provisoires chez Google) et leurs lignes remplacées ; les jours manqués sont rattrapés. Puis
  l'historique est importé en remontant le temps, sur 16 mois, par lots de 5 jours.
- **Bing** : un cycle complet à chaque passage (site, requêtes, pages, puis requêtes de chaque page).
- Chaque lot est borné dans le temps ; le curseur (`seo_connections.cursor`) est enregistré après chaque lot. Une
  interruption ne perd rien et ne double rien : les lignes sont écrites par clé unique.
- Jeton révoqué ou expiré, clé refusée : le connecteur passe « À reconnecter » avec son message, l'autre fournisseur
  et le reste du CRM continuent. Les chiffres déjà importés restent.

## Sécurité
- Jeton Google et clé Bing : chiffrés (AES-256-GCM, clé dérivée de `APPOINTMENTS_SECRET`) avant l'écriture, dans
  `seo_connection_secrets`, table sans aucun droit de lecture pour le navigateur. Ils ne sortent de la base que par
  une fonction protégée par la clé serveur.
- La clé Bing voyage dans l'adresse des appels (c'est l'API de Bing qui le veut) : ces adresses ne sont jamais
  journalisées ni reprises dans un message d'erreur.
- Connexion Google : état anti-rejeu et PKCE en cookies `httpOnly`, comme pour Google Agenda.
