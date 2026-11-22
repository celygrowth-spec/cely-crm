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

## Réception (audit, lot 5 — Q03)
- La connexion Gmail demande désormais **l'envoi et la lecture** (`gmail.readonly`). Un compte connecté avant cette
  version doit être **reconnecté** pour activer la réception (Paramètres › Passages planifiés l'indique).
- Lecture planifiée (`/api/cron`, tâche « gmail ») : initiale bornée (30 jours, 150 messages), puis incrémentale
  (historique Gmail) ; reprise sur 3 jours si l'historique a expiré.
- Rattachement : seuls les emails d'une adresse présente dans le CRM sont conservés. Une seule fiche : rattaché,
  ajouté à l'historique, relances de l'entreprise en pause et réponse dans « Aujourd'hui ». Plusieurs fiches :
  « Emails à rattacher » (Mail › à rattacher), résolu à la main, jamais modifié ensuite. Messages automatiques
  (réponse d'absence, liste, noreply, promotions) : conservés « ignorés », sans effet. Un email déjà vu ou envoyé par le
  CRM n'est jamais importé deux fois. Pièces jointes : noms et tailles seulement, à ouvrir dans Gmail.
- Testé avec des messages Gmail simulés uniquement : la lecture réelle demande votre reconnexion.

## Boîte Gmail entière (Mail, lot M01)
- Le CRM tient un **index** de toute la boîte : Boîte de réception, Envoyés, Brouillons, Spam, Corbeille, Tous les
  messages, libellés personnels et catégories, avec l'état de chaque fil (lu, suivi, important, libellés).
- **Ce qui est conservé** : expéditeur, destinataires, objet, extrait, date, libellés, présence d'une pièce jointe.
  Le corps des messages et les pièces jointes restent dans Gmail. Déconnecter le compte efface l'index.
- **Autorisation** : la lecture déjà accordée (`gmail.readonly`) suffit pour ce lot. Le tri et la rédaction (lots
  suivants) demanderont `gmail.modify` et une reconnexion.
- **Première lecture** : toute la boîte, par lots, des messages les plus récents aux plus anciens. Elle avance tant
  que la page Mail est ouverte, et à chaque passage planifié ; une coupure reprend au lot suivant.
- **Ensuite** : seuls les changements sont relus (historique Gmail). Page Mail ouverte : toutes les minutes.
  Page fermée : au rythme du passage planifié `boite` (voir docs/planificateur.md). Si l'historique Gmail a expiré
  (plus d'une semaine sans passage), la boîte est relue en entier et ce qui n'existe plus est retiré.
- **En cas d'échec** : la carte « Boîte Gmail » de la page Mail affiche le motif et la marche à suivre (reconnecter,
  ou attendre la reprise automatique). Les repères restent en place : rien n'est relu deux fois, rien n'est perdu.
- **Variables d'environnement** : aucune nouvelle. La synchronisation utilise `GOOGLE_MAIL_CLIENT_ID`,
  `GOOGLE_MAIL_CLIENT_SECRET`, `MAIL_TOKEN_KEY` et `APPOINTMENTS_SECRET` (clé des fonctions serveur), déjà requises.
- **Base de données** : `supabase/migrations/20261126100000_mail_boite.sql` (additive).
- Testé avec un Gmail simulé uniquement.

## Lecture de la boîte (Mail, lot M02)
- **Mail › Boîte** : dossiers et libellés à gauche avec leur compteur (non-lus, ou total pour les brouillons), liste
  des fils par pages de 50 chargées au défilement, fil ouvert à droite avec ses pièces jointes.
- **Recherche** : la saisie est transmise telle quelle à Gmail, qui applique sa syntaxe (`from:`, `to:`, `subject:`,
  `has:attachment`, `in:spam`, `older_than:`…). Les résultats suivent l'ordre de Gmail.
- **Contenu des messages** : lu dans Gmail à l'ouverture, jamais stocké. Le HTML reçu est nettoyé côté serveur puis
  affiché dans un cadre isolé où aucun script ne s'exécute. Les images distantes sont masquées par défaut (elles
  signalent l'ouverture à l'expéditeur) ; « Afficher les images » les charge pour le fil ouvert.
- **Pièces jointes** : téléchargées depuis Gmail à la demande, toujours comme fichier à enregistrer.
- **Lecture seule à ce stade** : ouvrir un message ne le marque pas comme lu dans Gmail (le tri arrive au lot M03).
- **Base de données** : `supabase/migrations/20261126110000_mail_boite_lecture.sql` (additive, après la précédente).

## Tri de la boîte (Mail, lot M03)
- **Autorisation** : la connexion demande désormais aussi `gmail.modify` (tri, libellés, corbeille, brouillons) et
  `gmail.settings.basic` (signature, lot M04). Un compte connecté avant ce lot reste en **lecture seule** jusqu'à sa
  reconnexion (bandeau dans Mail › Boîte). Dans Google Cloud › Accès aux données, ajoutez ces deux autorisations.
- **Actions** : archiver, supprimer (corbeille Gmail), restaurer, marquer lu ou non lu, suivre, important, signaler
  comme spam ou non-spam, ajouter ou retirer un libellé, déplacer. Sur le fil ouvert ou sur une sélection.
- **Dans Gmail d'abord** : l'écran se met à jour tout de suite, puis l'index reprend l'état renvoyé par Gmail. Si
  Gmail refuse, l'écran revient en arrière avec le motif.
- **Double clic** : chaque action vise un état (« marquer lu », jamais « inverser ») et une action en cours sur les
  mêmes fils n'est pas renvoyée.
- **Ouvrir un fil non lu** le marque lu, dans Gmail aussi.
- **Suppression définitive** : non proposée. Gmail vide sa corbeille après 30 jours.
- **Base de données** : `supabase/migrations/20261126120000_mail_boite_tri.sql` (additive, après les deux précédentes).

## Rédaction depuis la boîte (Mail, lot M04)
- **Nouveau message, Répondre, Répondre à tous, Transférer**, avec Cc, Cci et pièces jointes. Une réponse reste dans
  le fil d'origine, côté Gmail comme côté CRM.
- **Brouillons** : ce sont ceux de Gmail. La saisie y est enregistrée après deux secondes sans frappe ; un brouillon
  commencé dans Gmail se reprend ici (dossier Brouillons › « Modifier le brouillon »), et inversement.
- **Signature** : celle réglée dans Gmail pour l'adresse du compte (autorisation `gmail.settings.basic`), sinon la
  signature saisie dans Mail › Compte et envois. Les images d'une signature ne sont pas reprises.
- **Envoi unique** : l'envoi part du brouillon Gmail. Un verrou en base empêche deux envois du même brouillon (double
  clic, deux onglets) et Gmail retire le brouillon une fois parti.
- **Échec d'envoi** : le brouillon reste dans Gmail et la fenêtre reste ouverte avec le motif. Si Gmail ne répond pas
  clairement, le CRM vérifie si le brouillon existe encore avant de conclure ; en cas de doute, il le dit et ne
  renvoie rien de lui-même.
- **Pièces jointes** : 18 Mo au total par message. Les fichiers ajoutés depuis l'ordinateur passent par le serveur :
  4 Mo au plus par ajout (ajoutez les gros fichiers un par un). Les pièces jointes d'un message transféré sont
  reprises directement depuis Gmail, sans cette limite par ajout.
- **Différences avec l'envoi depuis une fiche** : ces messages ne passent pas par les modèles, les variables ni le
  suivi des liens. L'envoi depuis une fiche (Mail du CRM) est inchangé.
- **Base de données** : `supabase/migrations/20261126130000_mail_boite_redaction.sql` (additive, après les trois
  précédentes) : verrous d'envoi, sans aucun contenu de message.

## Lien avec les fiches (Mail, lot M05)
- **Panneau à côté du fil** : quand un correspondant du fil est une personne d'une fiche, le panneau affiche
  l'entreprise (clic : ouvre la fiche), la personne, l'étape de pipeline (ou le statut de prospection) et la
  prochaine action.
- **Créer la fiche** : proposé quand le correspondant n'a pas de fiche. Le formulaire est prérempli (personne et
  adresse ; société et site déduits du domaine, sauf messagerie personnelle). Les contrôles de doublon habituels
  s'appliquent.
- **Historique** :
  - mail reçu d'une personne d'une fiche : ajouté par la réception Gmail existante (inchangée) ;
  - mail envoyé depuis une fiche : ajouté par l'envoi du CRM (inchangé) ;
  - mail envoyé depuis la boîte (lot M04) aux personnes d'une seule fiche : ajouté à son historique à l'envoi.
  Un même message Gmail n'est jamais enregistré deux fois, quel que soit le chemin.
- **Non rattaché d'office** : un envoi vers plusieurs fiches à la fois, ou un message envoyé directement depuis
  l'application Gmail (hors CRM).
- **Base de données** : `supabase/migrations/20261126140000_mail_boite_fiches.sql` (additive, après les quatre
  précédentes).

## Suites possibles (hors périmètre)
Mise en attente d'un message, envoi programmé et annulation d'envoi : l'API Gmail ne les fournit pas, ils seraient à
recréer côté CRM. Également : notifications instantanées de Gmail (Pub/Sub) à la place de l'interrogation chaque
minute, images intégrées des signatures, rattachement des envois faits depuis l'application Gmail.
