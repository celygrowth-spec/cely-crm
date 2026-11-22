# Contrat CMS ↔ site celygrowth.com (version 1)

Ce document est à coller tel quel dans le prompt de la session qui travaille sur le dépôt du site.

## Principes

- Le **CMS de Cely Growth (le CRM) est la source de vérité** des articles du blog et des réglages SEO des pages.
  Le site ne stocke aucun contenu du CMS : il le lit, le met en cache et l'affiche.
- Le site lit le CMS par un **accès en lecture seule** (HTTPS, JSON), authentifié par une clé secrète.
- Le CMS **demande au site de se rafraîchir** (appel HTTPS signé) quand ce qui est affiché change. En plus, le site
  ne garde jamais une donnée du CMS plus de **15 minutes** sans la relire (filet de sécurité).
- Aucun lien GitHub entre les deux projets ; ils sont sur deux comptes Vercel distincts.
- Lis d'abord les instructions du dépôt du site et la documentation de la version de Next.js installée avant d'écrire
  du code. N'ajoute aucune dépendance.

## Variables d'environnement du site (noms seulement, valeurs fournies par le propriétaire)

| Nom | Rôle |
| --- | --- |
| `CELY_CMS_API_URL` | Adresse de base de l'accès : `https://cely-crm.vercel.app/api/site/cms/v1` (sans `/` final) |
| `CELY_CMS_API_KEY` | Clé de lecture (même valeur que `CMS_SITE_API_KEY` côté CRM), 32 caractères au moins |
| `CELY_CMS_REVALIDATE_SECRET` | Secret de l'appel de rafraîchissement (même valeur que `CMS_SITE_REVALIDATE_SECRET` côté CRM), 24 caractères au moins |

Documente ces trois noms (jamais leurs valeurs) dans le fichier d'exemple d'environnement du site. Ne journalise
jamais la clé, le secret ni un jeton d'aperçu. Ces variables ne doivent jamais être exposées au navigateur (pas de
préfixe `NEXT_PUBLIC_`) : tous les appels au CMS se font côté serveur.

## Appels

Tous en `GET`, côté serveur uniquement, avec l'en-tête :

```
Authorization: Bearer <CELY_CMS_API_KEY>
```

Chaque réponse JSON porte `"version": 1`. Dates : ISO 8601 en UTC (`2026-12-01T08:30:00+00:00` ou `…Z`).

| Appel | Renvoie |
| --- | --- |
| `GET {CELY_CMS_API_URL}/articles?page=1&par_page=20` | Liste des articles visibles, les plus récents d'abord (sans le contenu). Filtres facultatifs : `categorie=…`, `tag=…` (insensibles à la casse). `par_page` : 1 à 100. |
| `GET {CELY_CMS_API_URL}/articles/{slug}` | Un article visible avec son contenu, **ou** une redirection 301, **ou** 404 |
| `GET {CELY_CMS_API_URL}/redirections` | Toutes les redirections 301 (anciens slugs → slug actuel) |
| `GET {CELY_CMS_API_URL}/pages` | Réglages SEO des pages du site, par chemin |
| `GET {CELY_CMS_API_URL}/sitemap` | Articles à mettre dans le sitemap, pages à en retirer |
| `GET {CELY_CMS_API_URL}/apercu?jeton={jeton}` | Aperçu d'un article quel que soit son statut (jeton valable 24 h au plus) |

### Visibilité (appliquée par le CMS, rien à filtrer côté site)

Un article n'est renvoyé que s'il est **Programmé ou Publié et que sa date de publication est passée**. Jamais un
brouillon, un article programmé dans le futur, un article dépublié ou supprimé. La seule exception est l'aperçu avec
un jeton valide.

### Codes de réponse

| Code | Sens | Conduite du site |
| --- | --- | --- |
| 200 | Données | — |
| 400 | Requête invalide | Bug côté site : corriger l'appel |
| 401 | Clé absente ou fausse | Vérifier `CELY_CMS_API_KEY` ; ne pas réessayer en boucle |
| 404 | Article introuvable ou non visible (`{"version":1,"error":"not_found"}`) | `notFound()` |
| 429 | Trop d'appels (en-tête `Retry-After: 60`) | Garder le contenu en cache ; réessayer plus tard |
| 503 | CMS indisponible ou non configuré | Garder le contenu en cache ; ne jamais faire échouer le build ni la page pour ça |

Limites : 600 appels par minute et par adresse appelante, 3 000 au total ; 20 refus de clé par minute et par adresse.
Avec le cache décrit plus bas, le site en reste très loin.

### Article (champ `article` de `/articles/{slug}` et de `/apercu`)

```json
{
  "type": "article",
  "slug": "relancer-un-prospect",
  "title": "Comment relancer un prospect sans le perdre",
  "excerpt": "Trois relances, un message utile…",
  "cover_image": { "url": "https://….supabase.co/storage/v1/object/public/cms-media/….png", "alt": "Texte alternatif" },
  "category": "Prospection",
  "tags": ["relance", "email"],
  "author": "Célien",
  "keywords": ["relance prospect", "relance email"],
  "seo": {
    "title": "Relancer un prospect : la méthode",
    "description": "Trois relances, un message utile…",
    "og_title": "Relancer un prospect : la méthode",
    "og_image": "https://….png",
    "canonical": null,
    "noindex": false
  },
  "published_at": "2026-12-01T08:30:00+00:00",
  "first_published_at": "2026-12-01T08:30:00+00:00",
  "updated_at": "2026-12-03T10:12:00+00:00",
  "reading_minutes": 6,
  "content_markdown": "## Pourquoi relancer\n\n…",
  "content_html": "<h2 id=\"pourquoi-relancer\">Pourquoi relancer</h2>\n<p>…</p>",
  "headings": [{ "level": 2, "text": "Pourquoi relancer", "id": "pourquoi-relancer" }],
  "extra": {}
}
```

- `excerpt`, `cover_image`, `category`, `author`, `seo.description`, `seo.og_image`, `seo.canonical` peuvent valoir `null`.
- `seo.title` et `seo.description` sont **déjà pré-remplis** par le CMS (titre de l'article, extrait) quand ils sont
  vides ; `seo.og_title` vaut le title tag à défaut ; `seo.og_image` vaut l'image de couverture à défaut.
- `seo.canonical` vaut `null` : le site utilise l'adresse de l'article, `https://www.celygrowth.com/blog/{slug}`.
- `seo.noindex` : `true` → balise robots `noindex` sur la page **et** article absent du sitemap.
- `content_html` est **déjà nettoyé** par le CMS (liste fermée de balises, aucun script, aucun attribut `on…`, liens
  `http(s)`, `mailto`, `tel`, relatifs ou ancres uniquement). Le site l'affiche tel quel
  (`dangerouslySetInnerHTML`) dans un conteneur stylé. Balises possibles : `h1`–`h6` (avec `id`), `p`, `br`, `hr`,
  `strong`, `em`, `del`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `a`, `img` (`loading="lazy"`), `table`,
  `thead`, `tbody`, `tr`, `th`, `td`, `input type="checkbox" disabled`. Si le site préfère rendre
  `content_markdown` lui-même, il doit le nettoyer avec la même rigueur (pas de HTML brut).
- `headings` sert au sommaire (ancres `#id`).
- `published_at` : date affichée ; `updated_at` : dernière modification du contenu (pour `dateModified` et le sitemap).
- `extra` : réservé aux futurs types de contenus (études de cas, témoignages, FAQ) ; vide pour un article.

### Liste (`/articles`)

```json
{
  "version": 1,
  "total": 42,
  "page": 1,
  "per_page": 20,
  "next_change_at": "2026-12-05T08:00:00+00:00",
  "items": [ { "…": "mêmes champs qu'un article, sans content_markdown, content_html, headings, extra" } ]
}
```

`next_change_at` : heure de la prochaine apparition programmée (aucun contenu), ou `null`. Le site peut s'en servir
pour raccourcir son cache, ce n'est pas obligatoire.

### Redirection (`/articles/{ancien-slug}`)

```json
{ "version": 1, "redirect": { "to": "nouveau-slug", "status": 301 } }
```

Le site répond par une **redirection permanente** vers `/blog/{to}` (`permanentRedirect`). Les redirections ne
forment jamais de chaîne : `to` est toujours le slug actuel d'un article visible.

`/redirections` renvoie la liste complète, utile si le site préfère les appliquer dans son proxy :

```json
{ "version": 1, "redirects": [ { "type": "article", "from": "ancien-slug", "to": "nouveau-slug", "status": 301 } ] }
```

### Pages SEO (`/pages`)

```json
{
  "version": 1,
  "pages": [
    { "path": "/", "title": "Cely Growth — Croissance B2B", "description": "…" },
    { "path": "/merci", "noindex": true },
    { "path": "/offres", "og_image": "https://….png", "canonical": "https://www.celygrowth.com/offres" }
  ]
}
```

- Champs possibles : `path`, `title`, `description`, `og_title`, `og_image`, `canonical`, `noindex`.
- **Un champ absent signifie : le site garde la valeur inscrite dans son code.** Seuls les champs présents
  remplacent la valeur du code. `noindex` absent : valeur du code ; `true` : ne pas indexer ; `false` : indexer.
- Chemin : commence par `/`, sans paramètres, sans `/` final (sauf `/`). Une page du site sans entrée garde tout.

### Sitemap (`/sitemap`)

```json
{
  "version": 1,
  "articles": [ { "slug": "relancer-un-prospect", "updated_at": "…", "published_at": "…", "canonical": null } ],
  "noindex_pages": ["/merci"]
}
```

- Les articles listés sont visibles et indexables. Si `canonical` est renseigné et différent de
  `https://www.celygrowth.com/blog/{slug}`, ne mets pas l'article dans le sitemap.
- Retire du sitemap du site les chemins de `noindex_pages`.
- Un article dépublié ou supprimé disparaît de cette liste : il quitte le sitemap au rafraîchissement suivant.

### Aperçu (`/apercu?jeton=…`)

Le CMS crée des liens de la forme **`https://www.celygrowth.com/apercu?jeton={jeton}`** (le jeton fait 43 caractères
`A-Z a-z 0-9 - _`). Le site doit :

1. créer la route `/apercu`, qui lit `jeton` et appelle `GET {CELY_CMS_API_URL}/apercu?jeton={jeton}` **sans cache**
   (`cache: "no-store"`) ;
2. afficher l'article comme une page d'article, avec un bandeau « Aperçu — non publié » (statut dans
   `preview.status` : `draft`, `scheduled`, `published` ou `unpublished`) ;
3. poser `robots: noindex, nofollow` et l'en-tête `X-Robots-Tag: noindex`, ne jamais mettre la page en cache, ne
   jamais l'inclure dans le sitemap, ne jamais journaliser le jeton ;
4. répondre 404 si le CMS répond 404 (jeton faux ou expiré).

Réponse : `{ "version": 1, "preview": { "status": "draft", "expires_at": "…" }, "article": { … } }`.

## Cache et rafraîchissement attendus côté site

1. **Chaque lecture du CMS** (hors aperçu) passe par le cache de données de Next avec l'étiquette `cms` (et, si tu
   veux, des étiquettes plus fines) et une durée de **900 secondes au plus** :
   `fetch(url, { headers, next: { tags: ["cms"], revalidate: 900 } })` (ou `cacheTag("cms")` + `cacheLife` avec
   `revalidate ≤ 900` si le dépôt utilise `"use cache"`). Vérifie la syntaxe dans la documentation de la version
   installée.
2. **Route de rafraîchissement** : `POST /api/cms/revalidate` sur le site.
   - En-têtes reçus : `Authorization: Bearer <CELY_CMS_REVALIDATE_SECRET>`, `Content-Type: application/json`.
   - Corps reçu :
     ```json
     { "tags": ["cms", "cms:articles", "cms:sitemap", "cms:redirections", "cms:article:relancer-un-prospect", "cms:pages", "cms:page:/offres"],
       "reasons": ["publication : relancer-un-prospect"], "sent_at": "2026-12-01T08:30:02.123Z" }
     ```
     `tags` contient toujours `cms`. Les autres étiquettes décrivent ce qui a changé (`cms:article:{slug}` pour
     l'ancien et le nouveau slug, `cms:page:{chemin}`) ; le site peut s'en servir ou les ignorer.
   - Vérifie le secret en temps constant (`timingSafeEqual`) ; secret absent ou faux → `401`, sans rien faire.
   - Invalide **au moins** l'étiquette `cms` avec une expiration immédiate, pour que le contenu retiré
     (dépublié) ne soit plus jamais servi : dans cette version de Next, `revalidateTag("cms", { expire: 0 })`
     (forme à deux arguments ; vérifie dans la documentation installée). Fais de même pour les étiquettes fines que
     tu utilises.
   - Réponds `200 {"ok": true}` en moins de 8 secondes. Toute autre réponse est un échec : le CMS réessaie
     automatiquement (délai croissant, une heure au plus) et l'affiche dans son écran Aujourd'hui.
   - Appels répétés sans effet de bord : le CMS peut envoyer deux fois la même demande.
3. **Résultat garanti** : un article programmé devient lisible par l'accès à son heure exacte ; il apparaît sur le
   site au plus tard au premier rafraîchissement (appel du CMS, ou expiration du cache de 15 minutes au plus).
   « Publier maintenant », une modification d'un article publié, une dépublication ou un réglage de page SEO
   déclenchent un appel immédiat.

## Pages du blog à prévoir

- `/blog` : liste paginée (`/articles`), avec catégories et tags si utile.
- `/blog/[slug]` : article (`/articles/{slug}`) ; `redirect` → `permanentRedirect("/blog/" + to)` ; 404 → `notFound()`.
  Métadonnées depuis `seo` (title, description, Open Graph avec `og_title` et `og_image`, canonique, robots) et
  données structurées `BlogPosting` (`headline`, `datePublished` = `published_at`, `dateModified` = `updated_at`,
  `image`, `author`, `keywords`).
- Métadonnées des autres pages : fusionne les champs présents de `/pages` (pour le chemin de la page) sur les
  valeurs du code.
- `sitemap.xml` : pages du site (moins `noindex_pages`) + articles de `/sitemap`.
- Images : servies par le stockage public du CRM (`https://<projet>.supabase.co/storage/v1/object/public/cms-media/…`).
  Si le site utilise `next/image`, autorise ce chemin dans `images.remotePatterns`.
- Le CMS indisponible ne doit jamais casser le site : garder le cache, afficher une liste vide plutôt qu'une erreur
  au build, et ne jamais publier une page d'erreur pour un article existant en cache.

## Format JSON d'import des pages (fourni par le site au CMS)

Le site produit un fichier (par exemple `cms-pages.json`) qui recense ses pages et leurs **valeurs actuelles dans le
code**. Le propriétaire l'importe dans le CMS (CMS › Pages SEO › Importer le JSON du site). L'import crée les pages
absentes et met à jour libellés et valeurs du code ; il ne modifie jamais les réglages saisis dans le CMS et ne
supprime aucune page. Les valeurs du code servent d'indication dans le CMS ; un champ laissé vide dans le CMS garde
la valeur du code.

```json
{
  "format": "cely-cms-pages",
  "version": 1,
  "pages": [
    {
      "path": "/",
      "label": "Accueil",
      "defaults": {
        "title": "Cely Growth — Croissance B2B",
        "description": "…",
        "og_title": null,
        "og_image": "https://www.celygrowth.com/og.png",
        "canonical": "https://www.celygrowth.com/",
        "noindex": false
      }
    },
    { "path": "/offres", "label": "Offres", "defaults": { "title": "Nos offres" } }
  ]
}
```

| Champ | Règle |
| --- | --- |
| `format`, `version` | Obligatoires : `"cely-cms-pages"`, `1` |
| `pages` | 500 au plus |
| `path` | Obligatoire. Commence par `/`, sans paramètres ni ancre ; un `/` final est retiré ; unique dans le fichier |
| `label` | Facultatif (200 caractères au plus) : nom lisible de la page |
| `defaults.title` | Facultatif, 200 caractères au plus |
| `defaults.description` | Facultatif, 400 caractères au plus |
| `defaults.og_title` | Facultatif, 200 caractères au plus |
| `defaults.og_image`, `defaults.canonical` | Facultatifs, adresses complètes en `http(s)://` |
| `defaults.noindex` | Facultatif, booléen |

Liste toutes les pages publiques du site (hors articles du blog, gérés par le CMS) : pages statiques, pages de
service, mentions légales… Une page dynamique sans chemin fixe n'y figure pas.
