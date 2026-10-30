# Cely CRM

Mini-CRM personnel de **Cely Growth** : prospection manuelle et pipelines commerciaux.
Une entreprise = un prospect = une opportunité = **une seule fiche**, qui passe de la base
de prospection aux pipelines sans jamais être copiée.

- **Prospection** : base de prospects, listes, modèles de séquences, campagnes manuelles, doublons, import/export CSV.
- **Pipelines** : pipelines et étapes personnalisables, kanban avec glisser-déposer, gagné/perdu.
- **À faire** : tâches et relances (en retard, aujourd'hui, à venir).
- **Finance** : missions par fiche CRM, revenus (factures émises ailleurs) et paiements partiels, charges et
  abonnements, suivi URSSAF (estimé / déclaré / payé), trésorerie, prévisions, EBITDA indicatif, simulation.
- **Paramètres** : sources du lead, connexion à Claude, compte.
- **Connecteur Claude (MCP)** : rechercher, consulter, créer, noter, déplacer, lister les relances, depuis Claude.

Stack : Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (Postgres, Auth, RLS) · Vercel.

---

## Structure

```
supabase/migrations/      Schéma, RLS et logique métier transactionnelle (SQL versionné)
src/lib/crm/              Logique partagée UI + connecteur : service, validation, normalisation, import
src/lib/mcp/tools.ts      Outils exposés à Claude
src/app/actions.ts        Server actions de l'interface
src/app/(app)/            Pages : prospection, pipelines, à faire, paramètres, fiche
src/app/api/mcp/          Serveur MCP (Streamable HTTP, OAuth)
src/app/api/export/       Export CSV
src/app/oauth/consent/    Écran de consentement OAuth (connexion de Claude)
src/components/           Fiche unique (panneau + page), composants UI
tests/                    Tests : règles SQL (PGlite), normalisation, import, connecteur
```

Les règles importantes vivent **en base**, dans des fonctions SQL appelées par l'interface comme par
Claude : anti-doublons (avec verrous contre les requêtes simultanées), idempotence, déplacement en
pipeline, campagnes, fusion transactionnelle, import. Toutes les tables sont protégées par RLS et
réservées au compte propriétaire (`app_owner`).

---

## 1. Configurer Supabase

1. Créez un projet sur [supabase.com](https://supabase.com) (région UE conseillée).
2. **Appliquez les migrations**, dans l'ordre, au choix :
   - Tableau de bord › **SQL Editor** : collez et exécutez `supabase/install.sql` (toutes les migrations en un
     seul fichier, régénéré par `npm run db:bundle`) ;
   - ou avec la CLI : `npx supabase login`, `npx supabase link --project-ref <ref>`, puis `npx supabase db push`.
3. **Fermez les inscriptions** : Authentication › Sign In / Providers › désactivez *Allow new users to sign up*.
4. **Créez votre compte** : Authentication › Users › *Add user* › *Create new user* (email + mot de passe, cochez *Auto Confirm User*).
5. **Déclarez-le propriétaire du CRM** (SQL Editor) :
   ```sql
   insert into public.app_owner (user_id)
   select id from auth.users where email = 'votre-email@celygrowth.com';
   ```
   Sans cette ligne, même un compte connecté ne voit rien (RLS).
6. Authentication › **URL Configuration** › *Site URL* : `http://localhost:3000` en local, puis l'URL Vercel en production.
7. Récupérez dans Project Settings › API : l'**URL du projet** et la **Publishable key** (ou l'ancienne clé *anon*).
   N'utilisez jamais la clé secrète / `service_role` : l'application n'en a pas besoin.

Aucune donnée fictive n'est créée. Les seules valeurs initiales sont les sources du lead
(LinkedIn, Email sortant, Recommandation, Site web, Événement, Autre), modifiables dans Paramètres.

## 2. Lancer en local

Prérequis : Node.js 20.9 ou plus récent.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Renseignez `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` dans `.env.local`, puis :

```bash
npm run dev
```

Ouvrez http://localhost:3000 et connectez-vous avec le compte créé à l'étape 1.

Vérifications (TypeScript, lint, tests, build) :

```bash
npm run check
```

## 3. Pousser sur GitHub

Le dépôt Git est déjà initialisé. Créez un dépôt **privé** puis poussez :

```bash
git add -A && git commit -m "Cely CRM v1"
```

```bash
gh repo create cely-crm --private --source=. --push
```

(Sans la CLI `gh` : créez un dépôt privé sur github.com, puis `git remote add origin <url>` et `git push -u origin main`.)
`.env.local` est ignoré par Git : aucun secret n'est versionné.

## 4. Déployer sur Vercel

1. [vercel.com](https://vercel.com) › *Add New Project* › importez le dépôt GitHub (framework détecté : Next.js).
2. *Environment Variables* : ajoutez `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` (Production et Preview).
3. *Deploy*.
4. Dans Supabase › Authentication › URL Configuration, mettez l'URL Vercel (ex. `https://cely-crm.vercel.app`)
   comme *Site URL*.
5. Conseillé : Vercel › Settings › Deployment Protection, protégez les déploiements *Preview*.

## 5. Connecter Claude

Le connecteur est un serveur MCP authentifié par **OAuth 2.1 via Supabase Auth** : vous vous connectez
avec votre compte, Claude reçoit un jeton limité à vos propres droits (RLS), et chaque écriture est
journalisée (visible sur la fiche et dans Paramètres). Il faut que l'application soit **déployée en HTTPS**
(Claude ne peut pas joindre `localhost`).

Côté Supabase (Authentication › **OAuth Server**) :

1. Activez le serveur OAuth 2.1.
2. *Authorization Path* : `/oauth/consent` (avec la *Site URL* réglée sur l'URL Vercel).
3. Activez *Dynamic OAuth Apps* (enregistrement dynamique des clients), utilisé par Claude.
4. Conseillé : Project Settings › JWT Keys, passez aux clés de signature asymétriques
   (vérification locale des jetons ; sinon la vérification interroge Supabase à chaque requête).

Côté Claude :

- **claude.ai / Claude Desktop** : Paramètres › Connecteurs › *Ajouter un connecteur personnalisé* ›
  URL `https://<votre-app>.vercel.app/api/mcp`. Claude ouvre la page de connexion du CRM puis l'écran
  de consentement : cliquez sur *Autoriser*.
- **Claude Code** :
  ```bash
  claude mcp add --transport http cely-crm https://<votre-app>.vercel.app/api/mcp
  ```
  puis `/mcp` dans Claude Code pour vous authentifier.

Outils disponibles : `search_companies`, `get_company`, `create_company` (avec contrôle des doublons),
`add_person`, `log_interaction` (note, message envoyé ou reçu, appel, rendez-vous), `create_task`,
`postpone_task`, `list_pipelines`, `move_company`, `list_followups`.
Volontairement absents : envoi de messages, fusion, suppression, modifications en masse (refusés aussi
en base pour un jeton Claude).

Révoquer l'accès : Supabase › Authentication › OAuth Apps.

---

## Comportements clés

- **Anti-doublons** sur toutes les entrées (création, modification, import, Claude) : domaine identique,
  email identique, profil LinkedIn identique = correspondance forte ; nom d'entreprise ou de personne
  proche = à vérifier. Les messageries grand public (Gmail, Outlook…) ne rapprochent jamais deux
  entreprises. Rien n'est fusionné automatiquement ; une création distincte reste possible après confirmation.
- **Fusion** explicite (Prospection › Doublons), transactionnelle : personnes, historique, tâches,
  listes et campagnes conservés ; l'ancienne fiche garde son identifiant et renvoie vers la fiche gardée.
- **Campagnes** : copier un message ne l'enregistre pas ; seul *Marquer comme envoyé* le fait. L'échéance
  suivante part de la date réelle d'envoi. Une réponse met le suivi en pause. Les étapes du modèle sont
  copiées à la création de la campagne.
- **Pipelines** : l'entrée dans un pipeline arrête par défaut les relances actives. Supprimer une étape ou
  un pipeline non vide exige une destination. Les fiches gagnées/perdues gardent leur dernière étape.
- **Import CSV** : correspondance des colonnes, regroupement des personnes d'une même entreprise,
  détection des doublons (fichier et base), choix explicite créer / compléter / exclure, résumé avec
  erreurs par ligne. Chaque ligne a une empreinte : réimporter le même fichier ne recrée rien.
- **Finance** : les clients sont les fiches CRM (aucune seconde base). Montants en `numeric(12,2)` en base et en
  centimes entiers côté TypeScript (`src/lib/finance/`). Factures et paiements ne se suppriment pas : avoirs,
  remboursements et annulations explicites. Un abonnement est un modèle ; seules ses échéances validées comptent
  comme payées. Une cotisation URSSAF payée ne sort qu'une fois de la trésorerie (vue `finance_cash_movements`).
  Les déclarations URSSAF saisies sont figées ; un changement de taux ne les modifie pas, les écarts sont signalés.
  Taux officiels encodés avec source et date de vérification (Réglages Finance) ; pour un autre statut, suivi manuel.
- **Archivage** plutôt que suppression ; les fiches archivées sont masquées et restaurables.

## Tests

`npm test` exécute :

- `tests/db` : les **vraies migrations** appliquées à un Postgres embarqué (PGlite) qui simule les rôles
  et `auth.uid()` de Supabase. Couvre la fiche unique, les listes, les campagnes, le transfert entre
  pipelines sans duplication, l'anti-doublons (domaine, email, LinkedIn, Gmail, sous-domaines, noms),
  l'import répété, la fusion, et le contrôle d'accès (anonyme, autre compte, jeton Claude) ;
- `tests/unit` : concordance de la normalisation TypeScript / SQL, regroupement d'import,
  authentification et périmètre du connecteur MCP.

Non couvert automatiquement : les parcours dans le navigateur contre un vrai projet Supabase, et la
connexion OAuth de bout en bout avec Claude (elle nécessite un déploiement public).
