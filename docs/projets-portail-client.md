# Projets et portail client

Un projet appartient à une fiche CRM (une entreprise peut en avoir plusieurs). Le portail client
(`/portail`) est une vue limitée **aux contenus explicitement partagés** ; le client n'a accès ni au CRM,
ni à la prospection, ni aux finances, ni aux notes internes.

## Ce que je gère, ce que le client voit, ce qu'il peut modifier

| Élément | Interne uniquement | Visible du client | Modifiable par le client |
| --- | --- | --- | --- |
| Projet | note interne, blocage | nom, description, statut, dates, message « Où en sommes-nous » (une fois **publié**) | — |
| Phases, jalons | jalons marqués internes | phases, jalons visibles | — |
| Points de suivi | points non visibles, note interne du rendez-vous | points rattachés et visibles : date, fuseau, lien, ordre du jour | — |
| Récapitulatifs | brouillons, note interne | récapitulatifs **publiés** | — |
| Tâches | tâches internes (par défaut) | tâches marquées visibles, et toutes celles attribuées au client | statut et explication d'un blocage de **ses** tâches (ou de l'équipe client) ; commentaires |
| Fichiers | documents de la fiche non partagés ; dossiers **internes** et leur contenu | racine du projet et dossiers **partagés** | dépôt dans les dossiers où il est ouvert ; renommer, déplacer, supprimer **ses** dépôts |
| Idées | — | toutes les idées du projet et les décisions | proposer, commenter ; modifier **son** idée tant qu'elle est « à explorer » |

Chaque écran d'administration indique « Visible du client » ou « Interne ». Toutes ces règles sont
vérifiées en base (fonctions `portal_*`), pas seulement masquées dans l'interface.

## Créer un projet

1. **Projets › Nouveau projet** (ou depuis la fiche CRM, section *Projets*).
2. Choisir l'entreprise, le nom, éventuellement description et dates, cocher les contacts du client.
3. Compléter ensuite : *Planning* (phases, jalons ; « Partir du modèle » propose Cadrage → Livraison),
   *Points*, *Tâches*, *Fichiers*.
4. Onglet *Général* : rédiger « Où en sommes-nous » et cocher **Publier le projet sur le portail**.
   Rien n'est visible tant que le projet n'est pas publié.

Archivage : statut « Archivé » ; choisir *lecture seule* (le client consulte encore) ou *accès fermé*.
L'historique est conservé.

## Générer, régénérer, révoquer un accès

1. Projet › **Accès client** › **Générer un accès** à côté du contact (expiration facultative).
2. Copier le **lien** (`https://…/portail`) et le **code** (ou « Copier un message prêt à envoyer »).
   Le code n'est affiché **qu'une fois** ; idéalement, transmettre lien et code par deux canaux.
3. Le contact ouvre le lien, saisit son code, et voit **tous les projets publiés dont il est membre**.

- **Régénérer** : l'ancien code cesse immédiatement de fonctionner, ses sessions sont fermées.
- **Révoquer** : plus aucune lecture ni écriture, sur tous ses projets, dès la requête suivante.
- **Retirer du projet** : il perd l'accès à ce projet uniquement.
- La liste indique l'état (actif, expiré, révoqué), les 4 derniers caractères du code et la dernière connexion.

Aucun email n'est envoyé automatiquement (voir « Intégrations »).

## Partager un point, un récapitulatif, un fichier

- **Point** : *Points › Nouveau point* crée le rendez-vous dans le module Rendez-vous, l'événement Google
  Agenda et, si le type de rendez-vous l'active, le lien **Google Meet** — une seule fois, sans doublon.
  Ou *Rattacher un rendez-vous existant* (uniquement ceux de la même fiche). Date, statut et lien sont lus
  en direct : un report ou une annulation se reflète sur le portail, un point annulé reste identifiable.
- **Récapitulatif** : *Points › Récapitulatif* — résumé, décisions, actions, prochaine étape, liens ;
  *Aperçu client* ; *Enregistrer et publier*. La note interne n'est jamais publiée. Chaque action peut
  devenir une **tâche** liée au point (une seule).
- **Fichier** : *Fichiers* — déposer directement (à la racine ou dans le dossier ouvert), ou *Partager avec
  le projet* un document existant de la fiche (référence, pas de copie). *Retirer du projet* ne supprime pas
  le document ; *Supprimer* le supprime partout (fiche et projets), après confirmation.
- **Dossiers** : *Nouveau dossier* (Factures, Contrats, Briefs, Livrables…), un niveau de sous-dossier.
  Chaque dossier est **visible du client** ou **interne**, et peut **accepter les dépôts du client**
  (sinon consultation seule). Le chemin s'affiche en haut (*Fichiers › Factures*). Renommer et régler :
  crayon du dossier. Supprimer un dossier non vide : choisir d'abord où déplacer ses fichiers (racine ou
  autre dossier) ; rien n'est supprimé.
  **Aucune exposition implicite** : déplacer un document d'un dossier interne vers la racine ou un dossier
  partagé, partager un dossier qui contient des documents, ou supprimer un dossier interne vers un
  emplacement visible demande une confirmation explicite. La base refuse ces changements sans elle
  (déclencheurs), même hors de l'interface. Un dossier « Factures » n'est qu'un dossier : il ne donne
  aucun accès au module Finance.
- **Mes prochains points** (accueil du portail, au-dessus de la timeline ; sur la page d'accueil quand le
  contact a plusieurs projets, avec le nom du projet) : le prochain point mis en avant, puis deux suivants.
  Titre (ouvre le détail du point et ses tâches), date, heure, fuseau ; *Rejoindre sur Google Meet* dès
  que le lien existe, sinon « Lien à venir ». Un report réordonne la liste, une annulation retire le point
  (il reste barré dans le déroulé). Les points passés et leurs récapitulatifs restent dans le déroulé.
- **Timeline** : mois et repères 10 · 20 · 30 (seulement les dates qui existent dans la période), adaptés
  à la largeur d'écran ; phases et points à leurs dates réelles ; trait « Aujourd'hui · date » distinct du
  repère « En cours · phase » (une phase peut se poursuivre après sa fin prévue : dépassement hachuré).
  La liste chronologique reste affichée sous la frise.
- **Aperçu** : *Prévisualiser le portail* montre la vue d'ensemble telle qu'un contact la voit (mêmes
  fonctions de visibilité). Cela ne remplace pas un essai avec un vrai code.

## Depuis Claude (connecteur MCP)

Claude gère les espaces client avec les mêmes opérations et les mêmes règles que l'application
(`src/lib/projects/service.ts`, migration `20261110000200_mcp_espaces_client.sql`). Chaque écriture est
journalisée dans `activity_log`, rattachée à la fiche.

| Sans accord | Après votre accord (`confirmed_by_user`) | Dans l'application uniquement |
| --- | --- | --- |
| Lire : `list_projects`, `get_project`, `get_project_task`, `preview_client_portal`, `list_linkable_bookings`, `get_project_file_url` | Publier, dépublier, archiver ; modifier ce que le client voit d'un projet publié (`update_project`) | Générer ou régénérer un code d'accès : il apparaîtrait dans la conversation |
| `create_project` (non publié) ; note interne et blocage (`update_project`) | Contacts d'un projet publié ; retirer un contact ; expiration et révocation d'un accès | Effacer définitivement un fichier |
| Tâches, jalons, points, dossiers, fichiers **internes** ; planning et idées d'un projet **non publié** ; brouillon de récapitulatif (`save_meeting_recap`) ; envoi d'un fichier dans un dossier interne | Rendre visible : tâche, jalon, point, dossier, fichier ; publier un récapitulatif ; `task_from_recap` ; idées, commentaires et planning d'un projet publié | Créer, reporter, annuler un rendez-vous, réconcilier Google (Claude ne fait que rattacher un rendez-vous existant) |
| | Supprimer : tâche, phase, jalon, dossier (documents déplacés) ; détacher un point (récapitulatif effacé) ; retirer un fichier du projet | Supprimer un projet (n'existe pas : archivage) |

- `confirmed_by_user` est une consigne suivie par Claude, pas un verrou : la base ne peut pas savoir si vous
  avez répondu. Pour un second garde-fou, réglez ces outils sur « demander à chaque fois » dans les réglages du
  connecteur, côté Claude. Le refus des actions de la dernière colonne, lui, est appliqué en base.
- La protection contre l'exposition implicite (documents internes, voir plus haut) s'applique aussi à Claude.
- Un commentaire ou une idée écrit par Claude apparaît au client signé de votre nom. Le journal du projet affiche
  « owner » ; c'est `activity_log` qui indique Claude.
- Un code déposé avant la migration échoue proprement (« action réservée à l'application », « rien n'a été
  modifié ») : appliquer la migration **avant** de déployer.

## Sécurité

- **Pas de compte Supabase pour les clients**, pas de clé `service_role`. Le serveur Next appelle les
  fonctions `portal_*` avec la clé publique, la **clé serveur** dérivée de `APPOINTMENTS_SECRET`
  (empreinte enregistrée en base, comme pour la réservation publique) et l'empreinte du jeton de session.
  Chaque fonction revérifie session, accès, appartenance au projet, publication et archivage.
- **Code** : 20 caractères aléatoires (alphabet Crockford, ~100 bits). Seul un HMAC poivré est stocké.
  Saisi dans le corps d'une requête POST : jamais dans l'URL, les journaux ou le stockage du navigateur.
- **Session** : jeton de 256 bits en cookie `httpOnly`, `SameSite=Lax`, `Secure` en HTTPS, 30 jours
  maximum (borné par l'expiration de l'accès) ; seule son empreinte est en base. Écritures : même origine
  exigée. Tentatives : 8 échecs par adresse IP en 15 minutes (empreinte de l'IP seulement).
- **Fichiers** : bucket privé ; le client n'obtient qu'un lien temporaire (5 minutes) après contrôle en base.
  Les politiques Storage du rôle `anon` n'ouvrent qu'**un objet précis pendant 60 secondes** (lecture,
  suppression de son propre dépôt) ou l'envoi d'un dépôt client en attente depuis moins de 15 minutes.
  Formats limités (aucun HTML/SVG), 25 Mo ; seuls PDF et images sont prévisualisés, le reste est téléchargé.
- **Pages** : `Cache-Control: private, no-store`, `noindex`, iframes interdites.
- Tests : `tests/db/projets*.test.ts` (accès directs par identifiant, session révoquée, clé absente,
  absence de contenu interne dans toutes les réponses du portail).

## Migrations (à appliquer dans l'ordre, après celles du dépôt)

| Fichier | Contenu |
| --- | --- |
| `20261107000100_projets.sql` | projets, membres, accès, sessions, tentatives, journal, fonctions du portail |
| `20261107000200_projets_planning_points.sql` | phases, jalons, points (rendez-vous), récapitulatifs, création de rendez-vous par le propriétaire, suivi des écarts Google |
| `20261107000300_projets_taches.sql` | tâches, commentaires, droits client |
| `20261107000400_projets_fichiers.sql` | dossiers, partages, dépôts client, politiques Storage |
| `20261107000500_projets_idees.sql` | idées, commentaires, idée → tâche |
| `20261107000600_projets_dossiers_points.sql` | dossiers partagés / internes, dépôt par dossier, déplacements confirmés, « Mes prochains points » |
| `20261110000200_mcp_espaces_client.sql` | ouverture des espaces client au connecteur Claude, journal de ses écritures |

Toutes sont additives. Elles ajoutent des colonnes à des tables existantes : `company_files`
(`uploaded_by_*`), `appt_bookings` (`google_drift*`), `appt_google_connection` (jeton de synchronisation).
**Base partagée** : ne pas les appliquer sans coordination avec les autres chantiers en cours.
`supabase/install.sql` est régénéré (`npm run db:bundle`).

Après déploiement : ouvrir une fois l'espace *Rendez-vous* (enregistre la clé serveur), sinon le portail
répond « service indisponible ».

## Intégrations

- **Rendez-vous / Google Agenda** : réutilisés tels quels (même service, même OAuth, mêmes identifiants
  d'événement déterministes). Ajouts : création d'un rendez-vous par le propriétaire (`appt_owner_book`),
  report par le propriétaire sans contrôle des disponibilités publiques (seul le chevauchement reste
  interdit), et lecture **incrémentale** des changements faits directement dans Google
  (`events.list` + `syncToken`, renouvelé en cas d'expiration).
  **Périmètre** : seuls les événements créés par l'outil sur l'agenda de destination sont lus ; un
  déplacement ou une suppression dans Google est **signalé** (point, détail du rendez-vous) avec trois
  choix : appliquer l'horaire de Google, annuler le point, ou rétablir Google selon Cely. Rien n'est
  appliqué automatiquement. Déclenchement : bouton « Vérifier maintenant » (onglet Points) et la route
  `/api/rendez-vous/reconcile` (tâche planifiée avec `CRON_SECRET`). Testé avec un Google simulé :
  à valider sur le vrai compte.
- **Fichiers** : module existant réutilisé (table `company_files`, bucket `company-files`, envoi direct
  navigateur → Storage, vérification de l'objet, nettoyage des transferts abandonnés).
- **Mail** : non utilisé. Le portail fonctionne sans email ; aucun envoi parallèle n'a été créé.
  Raccordement possible plus tard (à faire avec `sendMail`, session du propriétaire) : envoi du lien
  d'accès depuis *Accès client* ; notifications (nouveau récapitulatif, tâche attribuée). En attente.
- **Mascotte** : aucun visuel dans le dépôt (et le site celygrowth.com n'est pas joignable depuis
  l'environnement de développement). Tout est prêt : position près de la phase en cours, arrivée animée,
  petit saut quand une étape vient d'être terminée, animations coupées si l'utilisateur réduit les
  mouvements. Pour l'activer : déposer le fichier d'origine dans `public/brand/` et renseigner `MASCOT_SRC`
  dans `src/components/portal/mascot.tsx`.

## Limites connues

- Deux rôles seulement (administrateur, client) ; pas de rôle « lecture seule » par personne.
- Les tâches n'ont pas encore de pièces jointes dans l'interface (liens et commentaires uniquement ;
  la base accepte déjà un fichier lié à une tâche).
- Pas de recherche globale côté portail (recherche dans les fichiers du projet uniquement).
- Les listes du portail sont limitées (300 tâches, 300 fichiers, 200 idées par projet) : au-delà, les plus
  anciens éléments ne s'affichent pas (fichiers : un message l'indique).
- Le comportement de l'API Storage hébergée (contrôle des politiques à la signature des URL) a été
  vérifié contre une émulation locale fidèle aux politiques, pas contre un vrai projet Supabase.
