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
- Modifier une cible validée par le client retire sa validation : il voit « Modifiée depuis ta validation ».
- Fichiers déposés : documents de la fiche (`company_files`) et dossier **interne** « Onboarding offre découverte »
  du projet. Ils ne sont jamais visibles dans l'onglet Fichiers du portail.
- **Aujourd'hui** (tâches de projet qui me sont attribuées) : « Onboarding reçu, à traiter » à l'envoi (une seule,
  même au double clic), une action par commentaire du client sur une cible, et une seule action « Onboarding modifié
  après envoi » ouverte à la fois. L'historique de la fiche note « Onboarding offre découverte reçu ».
- **Connecteur Claude** : `get_project` renvoie `onboarding_offre_decouverte` (état, réponses, noms des fichiers,
  cibles, commentaires, changements), en lecture seule ; ni lien ni chemin de fichier.

## Côté client (portail)
Onglet **Onboarding** (si la case est cochée) → page plein écran : bienvenue, 7 questions, lemlist, blacklist,
archives LinkedIn (par compte, « plus tard » possible), autres documents, 3 cibles, récapitulatif, envoi.
Une question par écran, Entrée pour valider, sauvegarde à chaque réponse, brouillon gardé sur l'appareil en cas de
coupure, reprise exacte par contact. Deux contacts en même temps : une réponse modifiée entre-temps n'est pas
écrasée, les deux versions sont montrées. Après l'envoi, le client peut encore corriger ; je vois ce qui a changé.

## Contenus à modifier sans toucher à la logique
`src/lib/discovery/content.ts` : questions (`OFFER_QUESTIONS`), tutos lemlist et LinkedIn (étapes marquées
`review: true` = à relire), textes de la mascotte, déroulé des 28 jours, prénom affiché (« Envoyer à Célien »).
Captures des tutos : déposer les images dans `public/onboarding/` et renseigner `image` sur l'étape.
**Mascotte** : aucune illustration dans le dépôt, dessin SVG provisoire. Déposer le fichier dans `public/brand/` et
renseigner `MASCOT_SRC` dans `src/components/portal/mascot.tsx` (le portail et l'onboarding l'utilisent).

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

## Migration
`20261123000100_onboarding_offre_decouverte.sql` (additive, après `20261122001000`). Elle relève aussi la limite de
`company_files.size_bytes` et du bucket `company-files` à 1 Gio ; les autres circuits gardent leurs 25 Mo
(fonctions du portail, application).

## Recette (environnement de test local, données fictives)
```bash
APPOINTMENTS_SECRET=<secret de test> npm run test-env
```
puis `node tests/e2e/onboarding-decouverte-crm.cjs` et
`APPOINTMENTS_SECRET=<le même> node tests/e2e/onboarding-decouverte-client.cjs`.
Tests base : `npx vitest run tests/db/onboarding-decouverte.test.ts`.
