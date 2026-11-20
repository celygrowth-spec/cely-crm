# Tracking site

Mesure propriétaire de l'acquisition de celygrowth.com, dans le CRM : sources, campagnes UTM, pages, prospects,
mots-clés, IA, géographie. Aucun service tiers (ni GA4 ni outil de suivi) : tout reste dans Supabase.

## Comment ça marche

| Brique | Où |
|---|---|
| Script du site (page vue, temps passé, défilement, clic rendez-vous, formulaire, bandeau de consentement) | `src/lib/tracking/site-script.ts`, servi par `/api/site/mesure.js` |
| Point de collecte public | `/api/site/collect` → fonction `site_collect` |
| Passages des robots, signalés par le serveur du site | `/api/site/bot` → `site_bot_hit` |
| Classement des sources, UTM, robots | `src/lib/tracking/{sources,utm,bots}.ts` |
| Rattachement d'un rendez-vous à sa visite | `bookPublic` → `site_attach_booking` |
| Agrégats de l'espace Tracking site | fonctions `site_stats_*`, lues par `/api/tracking/<rapport>` |
| Connecteurs Search Console et Bing | [integrations/search-console-bing.md](integrations/search-console-bing.md) |

### Vie privée
- **Avant consentement** : ni cookie ni identifiant persistant. La visite porte un identifiant aléatoire gardé dans
  `sessionStorage` (effacé à la fermeture de l'onglet), qui relie ses pages et conserve ses UTM. Seul le chemin de la
  page est envoyé, jamais les paramètres de l'adresse (hors UTM et identifiants de clic publicitaire).
- **Adresse IP** : jamais stockée. Le pays vient de l'en-tête posé par Vercel. Deux empreintes salées servent à
  limiter les abus (changée chaque jour) et à écarter les visites du propriétaire.
- **Après consentement** : identifiant de visiteur dans `localStorage`, 13 mois au plus, jamais prolongé. Les visites
  suivantes sont reliées entre elles ; à la prise de rendez-vous, elles rejoignent la fiche.
- **Refus** : aussi simple qu'accepter (deux boutons identiques). **Retrait** : l'identifiant est supprimé du
  navigateur et de la base, ses visites restent comptées mais redeviennent anonymes.
- Un rendez-vous pris sans consentement reçoit quand même la source et les UTM de la visite en cours.
- Purge quotidienne des identifiants expirés (`site_purge`, dans le passage planifié « seo »).

### Sources
Priorité : **Campagne** (UTM présents), **Payant** (identifiant de clic : gclid, msclkid…), puis le référent :
**IA générative**, **Email**, **Recherche organique**, **Réseaux sociaux**, **Site référent**, sinon **Direct**.
`utm_source=chatgpt.com` sans nom de campagne est classé IA générative (les IA l'ajoutent elles-mêmes).
Les UTM sont normalisés (minuscules, sans accents, tirets, variantes et fautes de frappe regroupées) ; la valeur
d'origine est conservée dans `site_visits.utm_raw`.

Chaque rendez-vous garde sa **première source** (premier contact) et sa **dernière source** (visite de la
réservation). La source de la fiche est la première source ; elle n'est remplie que si elle est vide.

### Mes propres visites
- Automatique : chaque fois que j'utilise le CRM, l'empreinte de ma connexion est notée ; les visites du site venant
  de cette connexion ne sont pas comptées pendant 30 jours.
- Par appareil (téléphone en 4G, autre réseau) : ouvrir une fois `https://www.celygrowth.com/?cely_exclure=1`
  (`?cely_exclure=0` pour annuler).

### Robots
Le serveur du site signale les robots connus (GPTBot, ClaudeBot, PerplexityBot, Googlebot, Bingbot…). Leur origine
est contrôlée avec les plages d'adresses publiées par Google, Bing, OpenAI et Perplexity :
**vérifié**, **non vérifié** (nom connu, adresse démentie : usurpation probable) ou **non vérifiable** (l'éditeur ne
publie rien, par exemple Anthropic). Un passage non vérifié ne compte pas comme une lecture de la page.

## Variables d'environnement (par leur nom)

| Nom | Rôle |
|---|---|
| `APPOINTMENTS_SECRET` | Déjà en place : clé serveur des fonctions publiques (collecte comprise) |
| `SITE_TRACKING_SECRET` | Secret partagé avec le serveur du site pour signaler les robots (24 caractères au moins) |
| `SITE_TRACKING_ORIGINS` | Facultatif : origines autorisées en plus de celygrowth.com (preview du site), séparées par des virgules |
| `GOOGLE_SEARCH_CONSOLE_CLIENT_ID`, `GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET` | Facultatif : client OAuth dédié à Search Console (sinon celui de Google Agenda) |
| `CRON_SECRET` | Déjà en place : passage quotidien (synchronisation SEO, purge) |

Côté site : `CELY_TRACKING_SECRET` (même valeur que `SITE_TRACKING_SECRET`).

## Migrations (dans cet ordre)
1. `20261125140100_tracking_collecte.sql`
2. `20261125140200_tracking_liens_utm.sql`
3. `20261125140300_tracking_rattachement.sql`
4. `20261125140400_tracking_seo.sql`
5. `20261125140500_tracking_stats.sql`
6. `20261125140600_tracking_recommandations.sql`

Toutes sont rejouables et additives.

## Données fictives (environnement de test uniquement)
```bash
npm run test-env
```
```bash
node scripts/test-env/seed-tracking.mjs
```
```bash
node scripts/test-env/seed-tracking.mjs --supprimer
```
Le jeu couvre 12 mois (toutes sources, campagnes UTM, IA, rendez-vous, robots, mots-clés). Tout est marqué
`demo = true` ; `supabase/maintenance/delete-tracking-demo.sql` ne supprime que ces lignes.

## Prompt pour le dépôt du site

Le code de celygrowth.com n'est pas dans ce dépôt. À coller dans une session Claude Code ouverte sur le dépôt du site :

````text
Objectif : brancher celygrowth.com sur la mesure d'audience propriétaire du CRM Cely (aucun service tiers).
Le CRM est servi par https://cely-crm.vercel.app (c'est déjà l'origine du widget de réservation /api/rdv/widget.js).
Lis d'abord les instructions du dépôt et la documentation de la version de Next.js installée avant d'écrire du code.
Ne modifie rien d'autre que ce qui est listé. Aucune dépendance à ajouter.

1. Script de mesure (toutes les pages)
   Dans la mise en page racine, charge le script après l'interactivité, une seule fois :
     <script src="https://cely-crm.vercel.app/api/site/mesure.js" async data-cookies-url="/cookies"></script>
   (avec le composant Script de Next, stratégie afterInteractive). Le script gère seul : pages vues (y compris la
   navigation sans rechargement), temps passé, défilement, UTM conservés pendant la visite, clics vers la prise de
   rendez-vous (éléments data-cely-rdv et liens vers /rdv/…), envoi de formulaires, bandeau de consentement,
   transmission de la visite au cadre de réservation. Ne duplique aucune de ces fonctions.
   Si le site a une Content-Security-Policy : autorise https://cely-crm.vercel.app dans script-src et connect-src.

2. Robots (côté serveur)
   Les robots n'exécutent pas JavaScript : signale-les depuis le proxy / middleware du site.
   Pour chaque requête GET d'une page (pas /_next, pas /api, pas les fichiers statiques ni les images) dont
   l'en-tête User-Agent correspond à
     /bot|crawl|spider|GPT|ChatGPT|OAI-|Claude|anthropic|Perplexity|Google-|Applebot|Bytespider|Amazonbot|meta-external|cohere|Diffbot|YouBot|MistralAI|DuckAssist/i
   envoie SANS attendre la réponse (waitUntil), avec un délai maximal de 2 secondes, sans jamais bloquer ni ralentir
   la page, et en ignorant toute erreur :
     POST https://cely-crm.vercel.app/api/site/bot
     Authorization: Bearer <process.env.CELY_TRACKING_SECRET>
     Content-Type: application/json
     { "ua": "<User-Agent>", "path": "<chemin sans paramètres>", "ip": "<première adresse de x-forwarded-for>" }
   Si CELY_TRACKING_SECRET est absent, ne fais rien. Ne journalise ni le secret ni l'adresse IP.
   Documente la variable CELY_TRACKING_SECRET par son nom (jamais sa valeur) dans le fichier d'exemple d'environnement.

3. Formulaires (contact, article, lead magnets, diagnostics, collaboration)
   a. Ajoute à chaque formulaire un champ FACULTATIF « Comment m'avez-vous connu ? » : une liste
      (Recherche Google, LinkedIn, ChatGPT ou une autre IA, Recommandation, Email reçu, Événement, Autre)
      et, dès qu'un choix est fait, un champ libre « Une précision ? (facultatif) ».
      Transmets ces deux valeurs avec le reste du formulaire à la route /api/… existante (sans la casser si elle
      ne les connaît pas encore).
   b. Après un envoi RÉUSSI (réponse OK de la route), appelle :
        window.cely?.track("form", { label: "<nom court du formulaire>", email: <email saisi>, declared: <choix>, detail: <précision> })
      et ajoute l'attribut data-cely-ignore sur la balise <form> pour éviter un double comptage par l'écoute
      automatique. L'adresse n'est transmise au CRM que si le visiteur a accepté le suivi : le script s'en charge.

4. Consentement et pages légales
   Le bandeau est affiché par le script (Refuser et Accepter, deux boutons identiques). N'ajoute pas d'autre bandeau.
   - Dans le pied de page, ajoute un lien « Gérer mes choix de mesure d'audience » : un bouton ou un lien portant
     l'attribut data-cely-consent (le script rouvre alors le bandeau).
   - Page /cookies : remplace « Le site n'utilise aucun cookie de mesure d'audience ni de publicité » par un texte
     exact : le site mesure son audience lui-même, sans service tiers ; sans accord, la mesure est anonyme (aucun
     cookie, aucun identifiant conservé, adresse IP non enregistrée, un identifiant de visite effacé à la fermeture
     de l'onglet) ; avec accord, un identifiant est conservé 13 mois au plus dans le navigateur pour reconnaître les
     visites successives et les relier à une demande de rendez-vous ; le choix se modifie à tout moment avec le lien
     du pied de page ; aucune donnée n'est transmise à un tiers ni utilisée pour de la publicité.
   - Page /confidentialite : ajoute la mesure d'audience aux traitements (finalité, base légale : intérêt légitime
     pour la mesure anonyme et consentement pour l'identifiant, durée 13 mois, destinataire : Cely uniquement).

5. Vérification
   - Sur une preview : ouvre une page avec ?utm_source=linkedin&utm_medium=post&utm_campaign=test-preview, vérifie
     dans l'onglet Réseau un POST vers /api/site/collect (réponse 204 ; 403 signifie que l'origine de la preview n'est
     pas autorisée côté CRM : donne-moi l'adresse de la preview pour l'ajouter à SITE_TRACKING_ORIGINS).
   - Vérifie que le bandeau s'affiche, que Refuser ne crée aucune entrée cely_visiteur dans localStorage, que
     Accepter en crée une, et que le lien du pied de page rouvre le bandeau.
   - Vérifie que le score de performance de la page d'accueil ne bouge pas (script async, aucun rendu bloqué).
   - Liste dans la pull request les fichiers touchés et la variable d'environnement à créer sur Vercel.
````
