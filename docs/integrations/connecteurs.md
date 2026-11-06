# Espace Connecteurs (Paramètres › Connecteurs)

Une seule page pour savoir ce qui est relié au CRM, ce qui fonctionne et où agir. Réservée au propriétaire
(contrôle `app_owner` côté serveur) ; inaccessible au portail client.

## Principes

- **À l'ouverture**, la page lit uniquement ce que le CRM a déjà enregistré (tables de chaque module et
  dernières vérifications). Elle n'attend aucun fournisseur. La liste des accès Claude vient du serveur
  d'autorisation Supabase, avec 1,5 s maximum ; au-delà : « État non vérifiable » et « Vérifier ».
- **« Vérifier »** interroge un seul service (15 s au plus) et mémorise le résultat (`connector_checks` :
  date, réussite, message lisible, aucun secret).
- **Aucune deuxième intégration** : connexion, reconnexion, déconnexion et révocation réutilisent les
  parcours des modules Mail, Rendez-vous et Fireflies.
- Groupes : **À vérifier** (à reconnecter, erreur de synchronisation, à vérifier, non vérifiable),
  **Connectés** (connecté, géré dans Claude), **À configurer** (non connecté). Les groupes vides sont masqués.

## États

| État | Signification |
| --- | --- |
| Connecté | Autorisation active confirmée (par le fournisseur à la connexion, puis par chaque opération ou vérification réussie) |
| À reconnecter | Le fournisseur a refusé l'accès (révoqué, expiré, clé refusée) |
| Erreur de synchronisation | Connexion active, mais le dernier traitement a échoué (dernière réussite et dernier problème affichés) |
| Configuré, à vérifier | Configuration présente, jamais vérifiée ni utilisée, ou incomplète |
| Non connecté | Aucune connexion active |
| Géré dans Claude | Outil configuré dans Claude, sans lien avec le CRM |
| État non vérifiable | La source d'état n'a pas répondu |

Une variable d'environnement ou un jeton enregistré ne suffit jamais à afficher « Connecté ».

## Par connecteur

| Connecteur | Vérifiable depuis la page | Gérable depuis la page | Hors du CRM |
| --- | --- | --- | --- |
| **Gmail** (envoi) | Renouvellement de l'accès auprès de Google ; dernier envoi réussi ; dernier envoi en échec | Connecter / reconnecter (parcours OAuth du module Mail), déconnecter (envois suspendus, accès révoqué chez Google) | Client OAuth et consentement (Google Cloud), variables Vercel |
| **Google Agenda** (+ Meet) | Accès Google et liste des agendas ; dernière lecture des changements ; rendez-vous à répercuter | Connecter / reconnecter, déconnecter ; réglages détaillés dans Rendez-vous › Connexion agenda | Projet Google Cloud (API Calendar, redirection), variables Vercel. Meet est une option des types de rendez-vous |
| **Fireflies** | Clé API auprès de Fireflies ; dernier import, imports en échec, quota, configuration (présence des secrets) | Suivi, relance et import d'une période : Appels › Suivi Fireflies | Clé API et webhook dans Fireflies ; variables Vercel. Couper l'import = retirer `FIREFLIES_API_KEY` |
| **Claude · MCP Cely CRM** | Accès accordés (liste du serveur d'autorisation) ; dernière écriture de Claude (tous accès confondus) | Copier l'URL du serveur, retirer un accès client par client | Ajout du connecteur et choix des outils dans Claude |
| **Ubersuggest** | Rien : utilisé seulement depuis Claude | Rien | Connexion, vérification et retrait dans Claude |

## Accès Claude (MCP)

- Serveur : `/api/mcp`, OAuth 2.1 via Supabase Auth au nom du compte propriétaire. Un appel sans jeton,
  avec un jeton invalide ou avec un jeton de session ordinaire (sans `client_id`) est refusé (401) : aucune
  lecture ni écriture.
- Chaque client Claude autorisé apparaît avec son nom, ses portées et sa date d'autorisation. « Retirer »
  révoque son autorisation ; un jeton déjà émis reste valable au plus une heure.
- Un seul accès = vos usages de Claude le partagent. Pour distinguer « Claude quotidien » et « Claude
  Diagnostic », ajoutez le connecteur depuis chacun : chacun aura son accès, retirable séparément.
- Le journal (`activity_log`) ne distingue pas les clients et les lectures ne sont pas journalisées : aucune
  date de dernière utilisation par client n'est affichée.

## Migration

`20261109000100_connecteurs.sql` : table `connector_checks` (propriétaire uniquement). Additive.
