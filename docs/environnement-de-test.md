# Environnement de test (recette sans données réelles)

`.env.local` pointe vers la production : ne lancez jamais `npm run dev` pour une recette. Utilisez l'environnement
de test, qui force sa propre configuration (les variables passées l'emportent sur `.env.local`).

## Local (par défaut)

```bash
npm run test-env
```

- **Base** (`scripts/test-env/server.mjs`) : faux Supabase sur `127.0.0.1:54321`, en mémoire, recréé à chaque
  lancement. Il applique les **vraies migrations** du dépôt : mêmes fonctions, mêmes politiques RLS, mêmes règles
  métier que la production. PostgREST, Auth et Storage y sont réduits à ce que l'application utilise.
- **Application** : `next dev` sur `localhost:3000`, reliée à cette base. Aucun identifiant Google, Gmail,
  Fireflies ou Claude réel : ces intégrations restent désactivées ou simulées dans les tests.
- **Données fictives** (`scripts/test-env/seed.mjs`) : noms préfixés « [TEST] », emails en `example.test`
  (domaine réservé) ; reconnaissables et supprimables par `supabase/maintenance/delete-test-data.sql`.
- **Comptes contrôlés** (`scripts/test-env/browser.cjs`) : `owner` (propriétaire de l'application) et `stranger`
  (compte connecté sans droit), utilisables dans Playwright (`context(browser, "owner")`) ; requêtes SQL de
  contrôle via `sql()` (point d'entrée `/debug/sql`, local uniquement).
- **Mesures de performance** : `npm run build`, puis `node scripts/test-env/dev.mjs --prod`.

### Limites de l'environnement local
- Jetons non signés (l'authentification réelle de Supabase n'est pas rejouée) ; le contrôle des droits, lui,
  est le vrai (RLS, `assert_owner`, rôles `anon` / `authenticated`).
- Storage simulé en mémoire : les politiques d'accès aux objets sont vérifiées, mais pas le service réel
  (durée effective des liens signés, CDN). **C13 ne peut être conclu qu'avec un projet hébergé** (ci-dessous).
- PostgREST partiel (filtres courants, relations imbriquées un-à-plusieurs).

## Projet Supabase de test hébergé (nécessite votre intervention)

Indispensable pour vérifier le stockage réel (C13), l'authentification réelle et les liens signés.

1. Créez un projet Supabase **dédié aux tests** (jamais la production), par exemple « cely-test ».
2. SQL Editor : exécutez `supabase/install.sql` sur ce projet vide.
3. Créez un utilisateur de test (Authentication › Users) et inscrivez-le propriétaire :
   `insert into public.app_owner (user_id) values ('<id de l'utilisateur de test>');`
4. Copiez `.env.test.example` en `.env.test.local` (ignoré par Git) et renseignez l'URL et la clé publique **du
   projet de test**.
5. Lancez `npm run test-env:hosted` : l'application démarre reliée au projet de test (le script refuse de
   démarrer si `.env.test.local` est absent ou si son URL est identique à celle de `.env.local`).

Les données créées pendant la recette se suppriment avec `supabase/maintenance/delete-test-data.sql` (aperçu, puis
suppression).
