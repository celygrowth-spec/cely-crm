# Onboarding de l'offre découverte

Test à 500 € : 300 contacts, 3 cibles, email + LinkedIn, 28 jours. Le client remplit seul, dans son espace client,
tout ce qu'il faut pour lancer le test ; tout arrive rangé dans le CRM.

## Côté CRM
- **Projet › Général › carte Portail client › « Offre découverte »** : décochée par défaut. Elle est cochée d'office
  quand une **nouvelle** vente est liée au projet avec une mission dont le libellé contient « découverte »
  (jamais rétroactivement, jamais par-dessus mon choix). Décocher masque l'onglet du client, sans rien effacer.
- Bouton **Onboarding offre découverte** (en-tête du projet) → panneau de suivi : avancement par étape (non
  commencé, en cours, envoyé), réponses, fichiers (liens de 60 s), 3 cibles à préparer, commentaires, changements
  après l'envoi (avant / après), contacts et dernier écran vu, **Copier le lien**, **Voir comme le client**.
- **Réglage** (même panneau) : adresse à inviter dans lemlist, commune à tous les clients.
  Tant qu'il est vide, le client voit l'adresse par défaut (`LEMLIST_INVITE_DEFAULT` dans `content.ts`).
- Modifier une cible validée par le client retire sa validation : il voit « Modifiée depuis ta validation ».
- Fichiers déposés : documents de la fiche (`company_files`) et dossier **interne** « Onboarding offre découverte »
  du projet. Ils ne sont jamais visibles dans l'onglet Fichiers du portail.
- **Aujourd'hui** (tâches de projet qui me sont attribuées) : « Onboarding reçu, à traiter » à l'envoi (une seule,
  même au double clic), une action par commentaire du client sur une cible, et une seule action « Onboarding modifié
  après envoi » ouverte à la fois. L'historique de la fiche note « Onboarding offre découverte reçu ».
- **Connecteur Claude** : `get_project` renvoie `onboarding_offre_decouverte` (état, réponses, noms des fichiers,
  cibles, commentaires, changements) avec l'**origine** de chaque valeur ; ni lien ni chemin de fichier.
  Claude peut aussi écrire à ma place (voir « Écritures par le connecteur Claude » plus bas).

## Côté client (portail)
Onglet **Onboarding** (si la case est cochée) → page plein écran : bienvenue, 7 questions, lemlist, blacklist,
archives LinkedIn (par compte, « plus tard » possible), autres documents, 3 cibles, récapitulatif, envoi.
Une question par écran, Entrée pour valider, sauvegarde à chaque réponse, brouillon gardé sur l'appareil en cas de
coupure, reprise exacte par contact. Deux contacts en même temps : une réponse modifiée entre-temps n'est pas
écrasée, les deux versions sont montrées. Après l'envoi, le client peut encore corriger ; je vois ce qui a changé.

## Contenus à modifier sans toucher à la logique
`src/lib/discovery/content.ts` : questions (`OFFER_QUESTIONS`), tutos lemlist et LinkedIn (étapes marquées
`review: true` = à relire), textes de la mascotte, déroulé des 28 jours, prénom affiché (« Envoyer à Célien »),
libellés de « Je ne sais pas » (`UNKNOWN`) et du lien du site (`WEBSITE_FIELD`).
Captures des tutos : déposer les images dans `public/onboarding/` et renseigner `image` sur l'étape ; sans image,
l'emplacement affiche la légende `capture` (la capture exacte à faire). Les 4 captures lemlist viennent du centre
d'aide officiel de lemlist (adresse dans `source`, vérifiées le 22/11/2026).
**Mascotte** : Cély, la mascotte du site celygrowth.com, redessinée à l'identique en SVG dans
`src/components/discovery/mascot.tsx` (même tracé, mêmes couleurs ; poses par humeur). La mascotte de la timeline
du portail (`MASCOT_SRC`, `src/components/portal/mascot.tsx`) reste désactivée : elle attend un fichier image.

## « Je ne sais pas » et lien du site
- Sous chaque question, la case **Je ne sais pas** : cochée, le client passe à la suite sans répondre. Une question
  obligatoire laissée vide sans la case demande l'un ou l'autre (« Plus tard » reste possible). S'il répond ensuite,
  la case se décoche (dans l'écran, et en base : une réponse saisie l'emporte toujours).
- Côté CRM, ces questions ressortent en tête du panneau, bloc **À compléter avec le client**, et portent un badge
  dans la liste des réponses. Le connecteur Claude renvoie `a_completer_avec_le_client` et `je_ne_sais_pas`.
- Question 4 : champ facultatif **Lien de votre site (si vous en avez un)**. « exemple.fr » devient
  « https://exemple.fr » ; un lien invalide est refusé (navigateur, route, base). Le lien est recopié sur la fiche
  (site web) si elle n'en a pas, ou si son site venait déjà de l'onboarding ; un site que j'ai saisi n'est jamais
  écrasé (le panneau l'indique). L'historique de la fiche note « Site web renseigné par le client ».

## Écritures par le connecteur Claude
Outils (`src/lib/mcp/discovery-tools.ts`) : `set_discovery_enabled`, `save_discovery_answers` (réponses, « je ne sais
pas », lien du site), `save_discovery_targets`, `set_discovery_steps` (offer, lemlist, blacklist, linkedin, documents,
targets, recap), `start_discovery_file_upload` + `confirm_discovery_file_upload` (25 Mo au plus), `remove_discovery_file`,
`save_discovery_settings`.
- **Origine** de chaque valeur, posée en base : `client` (portail), `owner` (dictée par moi) ou `claude` (proposition).
  Colonnes `origin` (réponses, étapes, fichiers), `claude_filled` (champs d'une cible), `sent_origin` (envoi).
  Le client ne voit jamais ces origines ; s'il corrige une valeur, elle redevient la sienne.
- **Jamais d'écrasement silencieux** : une valeur saisie par le client ou par moi est conservée et renvoyée à Claude ;
  elle n'est remplacée qu'avec `overwrite=true`, et la valeur remplacée est renvoyée.
- **Accord** : dès que l'offre est cochée et le projet publié, toute écriture demande `confirmed_by_user=true` ;
  sans lui, rien n'est écrit et l'outil décrit l'effet de chaque valeur. `recap` (marquer l'onboarding envoyé sans le
  clic du client) le demande toujours ; un envoi fait par le client ne s'annule pas.
- **Journal** : chaque écriture de Claude arrive dans `activity_log` (table, ligne, origine). Aucun message n'est envoyé.
- Les fichiers déposés par Claude vont dans le dossier interne du projet, comme ceux du client ; ceux du client ne se
  retirent pas par le connecteur. Aucun outil ne télécharge un fichier d'onboarding (données personnelles).

## Fichiers lourds
- Limites par étape, contrôlées en base : blacklist 50 Mo (CSV, Excel, TXT), archive LinkedIn 1 Go (ZIP),
  documents 100 Mo. Type déduit de l'extension par le serveur.
- Au-delà de 6 Mo : envoi **reprenable** (protocole TUS de Supabase Storage, jeton d'envoi signé dans `x-signature`),
  reprise automatique après coupure, et après rechargement si le même fichier est re-sélectionné (24 h).
  Si le stockage refuse l'envoi reprenable, l'envoi simple signé prend le relais (sans reprise).
- **Projet Supabase hébergé** : la limite globale de taille des fichiers (Storage › Settings) doit être au moins
  à 1 Go (le forfait gratuit plafonne à 50 Mo). L'envoi reprenable avec jeton signé n'a été vérifié que contre
  l'émulation locale : à valider sur le projet de test hébergé.

## Sécurité
Tables `discovery_*` : aucune écriture directe (ni propriétaire, ni client) ; RLS lecture pour le propriétaire.
Côté client, uniquement les fonctions `portal_discovery_*` : session, appartenance au projet, publication,
archivage et case cochée revérifiés à chaque appel ; l'identifiant d'un autre projet répond « introuvable ».
Stockage privé ; politique Storage dédiée (objet d'un dépôt d'onboarding en attente depuis moins de 24 h) ;
téléchargements par liens de 60 s. Aucun contenu de fichier ni réponse n'est journalisé.
Aucune variable d'environnement nouvelle (le portail utilise déjà `APPOINTMENTS_SECRET`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`).

## Migrations
`20261129100000_mcp_ouverture.sql` (additive, après `20261129090000`) : origines, fonctions `discovery_answer_save`,
`discovery_step_save`, `discovery_mark_sent`, `discovery_file_attach`, `discovery_file_detach`, ouverture à Claude de
`discovery_set_enabled`, `discovery_settings_save` et `discovery_target_save` (deux paramètres facultatifs de plus),
`origins` dans `discovery_admin`. À appliquer avant de déployer (l'application actuelle fonctionne avec).

`20261128090000_onboarding_je_ne_sais_pas.sql` (additive, après `20261127100500`) : colonne
`discovery_answers.unknown` (fausse par défaut : les réponses déjà enregistrées restent valides), paramètre
`p_unknown` facultatif sur `portal_discovery_answer`, lien du site recopié sur la fiche, site de la fiche dans
`discovery_admin`. À appliquer avant de déployer l'application (l'ancienne application fonctionne avec).

`20261123150000_onboarding_offre_decouverte.sql` (additive, après `20261122001000`). Elle relève aussi la limite de
`company_files.size_bytes` et du bucket `company-files` à 1 Gio ; les autres circuits gardent leurs 25 Mo
(fonctions du portail, application).

## Recette (environnement de test local, données fictives)
```bash
APPOINTMENTS_SECRET=<secret de test> npm run test-env
```
puis `node tests/e2e/onboarding-decouverte-crm.cjs` et
`APPOINTMENTS_SECRET=<le même> node tests/e2e/onboarding-decouverte-client.cjs`.
« Je ne sais pas », lien du site, captures lemlist, double clic, mobile, vue CRM :
`APPOINTMENTS_SECRET=<le même> node tests/e2e/onboarding-je-ne-sais-pas.cjs`.
Tests base : `npx vitest run tests/db/onboarding-decouverte.test.ts tests/db/onboarding-je-ne-sais-pas.test.ts`.
