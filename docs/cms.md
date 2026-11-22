# CMS : contenus du site celygrowth.com

Menu **CMS** : Articles, Calendrier éditorial, Pages SEO, Images. Le CMS est la source de vérité ; le site lit les
contenus publiés par un accès en lecture seule (contrat complet : [cms-contrat-site.md](cms-contrat-site.md)).
Les fichiers Markdown ne servent qu'à l'import et à l'export.

## Articles
- Champs : titre, slug, extrait, contenu Markdown, couverture et texte alternatif, catégorie, tags, auteur, mot-clé
  cible et secondaires, title tag, meta description, titre et image de partage, canonique, « Ne pas indexer », date
  et heure de publication. Date de mise à jour du contenu et temps de lecture (200 mots/min) calculés par la base.
- Statuts : Brouillon, Programmé, Publié, Dépublié. **Visible sur le site si et seulement si Programmé ou Publié et
  date passée** (`cms_private.is_visible`), calculé à chaque lecture : aucune tâche planifiée n'est nécessaire pour
  qu'un article apparaisse à son heure. Programmé passe à Publié à l'ouverture du CMS et au passage « contenus ».
- Slug : créé depuis le titre, modifiable, unique. Changé sur un article déjà publié une fois : l'ancien devient une
  redirection 301 vers l'article (jamais de chaîne) ; une ancienne adresse reste réservée à son article.
- Title tag et meta description vides : pré-remplis avec le titre et l'extrait (affichés en grisé, renvoyés au site).
  Compteurs avec repères ~60 et ~155 caractères.
- Publier maintenant : un double clic ne publie qu'une fois. Programmer une date passée demande de confirmer une
  publication immédiate. Heures saisies et affichées à l'heure de Paris (heure d'été comprise), stockées en UTC.
- Supprimer : un article publié ou programmé doit d'abord être dépublié ; il part ensuite dans la Corbeille du CRM
  (restaurable 30 jours, type « Article du site »).
- Types futurs (études de cas, témoignages, FAQ) : une ligne dans `cms_private.types`, leurs champs propres dans
  `extra` ; tables, droits, redirections et accès du site sont déjà génériques.

## Rédaction, import, export
- Éditeur Markdown avec aperçu (écrire / côte à côte / aperçu), rendu par le même code que le HTML envoyé au site.
  Le HTML brut n'est pas pris en charge et le résultat passe par `sanitize-html` : aucun script ne peut être injecté
  (ni par saisie, ni par import).
- Blocs des articles du site (réponse directe, à retenir, encadrés, citation, post-it, définition, FAQ, outils
  interactifs) : syntaxe `:::nom` … `:::`, modèle complet dans [cms-modele-article.md](cms-modele-article.md).
- **Importer** (liste des articles) : un ou plusieurs `.md`, avec les images citées par une adresse locale. Le
  frontmatter remplit les champs (noms usuels d'autres outils acceptés : `description`, `date`, `image`,
  `categories`, `draft`…) ; champs manquants et remarques affichés par fichier. Slug existant : **Remplacer** ou
  **Créer une copie** (la copie est un brouillon avec un slug libre).
- **Exporter** : `.md` d'un article (éditeur) ou archive `.zip` de tous les articles. Export puis réimport (Remplacer)
  redonne un article identique (testé).
- Images : bucket public `cms-media` (PNG, JPEG, WebP, GIF, AVIF ; SVG refusé ; 10 Mo). Page Images : une image
  utilisée par un article ou une page n'est supprimée qu'après un avertissement qui nomme ses usages.

## Pages SEO
Liste des pages par chemin. Champ vide = le site garde la valeur de son code ; « Indexation » a trois états (valeur
du site, indexer, ne pas indexer). Import en lot du JSON `cely-cms-pages` fourni par le site : crée les pages,
met à jour libellés et valeurs du code, ne touche jamais aux réglages du CMS.

## Programmation et suivi
- Calendrier éditorial par mois et liste filtrable par statut.
- Toute modification qui change le site (publication, modification d'un article visible, dépublication, slug, page
  SEO) inscrit une demande de rafraîchissement, envoyée aussitôt au site, puis reprise par le passage planifié
  « contenus » en cas d'échec (1, 2, 4… minutes, une heure au plus). Un succès résout les échecs plus anciens.
- **Aujourd'hui** : publications du jour, des 7 prochains jours, et rafraîchissements en échec avec **Réessayer**.
- **Aperçu sur le site** : lien `CMS_SITE_URL/apercu?jeton=…` valable 1 à 24 h (seule l'empreinte du jeton est en
  base), pour un brouillon comme pour un article publié. « Retirer tous les liens d'aperçu » les invalide.

### Délai d'apparition d'un article programmé
L'accès en lecture le renvoie dès son heure. Le site le montre au plus tard à l'expiration de son cache (15 minutes
au plus, imposé par le contrat), ou plus tôt grâce à l'appel de rafraîchissement du passage « contenus ». Sur l'offre
Vercel actuelle (Hobby), le passage planifié de Vercel ne tourne qu'une fois par jour : le planificateur Supabase
(`supabase/maintenance/planificateur.sql`, toutes les 15 minutes, `taches=contenus,…`) est recommandé ; s'il est
déjà activé en production, sa tâche doit être recréée avec la nouvelle adresse pour inclure `contenus`.

## Accès pour le site (lecture seule)
Routes `GET /api/site/cms/v1/{articles, articles/{slug}, redirections, pages, sitemap, apercu}` (préfixe déjà public
dans le proxy). Contrôles : clé `CMS_SITE_API_KEY` (Bearer, comparaison en temps constant), puis clé serveur en base
(`cms_site_read`, fonction sans accès aux tables pour un visiteur), filtrage de la visibilité en base, limites d'abus
par empreinte d'adresse (600/min, 3 000/min au total, 20 refus de clé/min). Aucune écriture possible.

## Variables d'environnement (noms seulement)
| Où | Nom | Rôle |
| --- | --- | --- |
| Vercel du CRM | `CMS_SITE_API_KEY` | Clé de lecture donnée au site (32 caractères au moins) |
| Vercel du CRM | `CMS_SITE_URL` | Adresse publique du site (liens d'aperçu) |
| Vercel du CRM | `CMS_SITE_REVALIDATE_URL` | Route de rafraîchissement du site (`https://…/api/cms/revalidate`) |
| Vercel du CRM | `CMS_SITE_REVALIDATE_SECRET` | Secret de l'appel de rafraîchissement (24 caractères au moins) |
| Vercel du CRM | `APPOINTMENTS_SECRET`, `CRON_SECRET` | Déjà en place (clé serveur, passages planifiés) |
| Vercel du site | `CELY_CMS_API_URL` | `https://cely-crm.vercel.app/api/site/cms/v1` |
| Vercel du site | `CELY_CMS_API_KEY` | Même valeur que `CMS_SITE_API_KEY` |
| Vercel du site | `CELY_CMS_REVALIDATE_SECRET` | Même valeur que `CMS_SITE_REVALIDATE_SECRET` |

## Migrations (dans cet ordre)
1. `20261127100100_cms_articles.sql`
2. `20261127100200_cms_medias.sql`
3. `20261127100300_cms_pages.sql`
4. `20261127100400_cms_publication.sql`
5. `20261127100500_cms_acces_site.sql`

Additives ; elles ne modifient aucune table existante, sauf deux enregistrements dans des registres prévus pour ça :
le type de corbeille `cms_entry` (`trash_private.kinds`) et la tâche `contenus` dans la contrainte de
`scheduled_jobs` (ajout qui conserve les tâches déjà présentes, quel que soit l'ordre des fusions).

## Droits
Lecture et écriture réservées au compte propriétaire, dans l'application : RLS (`is_app_owner()` et
`current_actor() = 'user'` pour toute écriture) et contrôles dans chaque fonction. Un autre compte, le connecteur
Claude (MCP non étendu) et un visiteur n'ont ni lecture ni écriture (tests `tests/db/cms-*.test.ts`).

## Ubersuggest (lot 6) : non fait
Le connecteur Ubersuggest existant est branché sur Claude, pas sur le CRM (Paramètres › Connecteurs : « aucune
connexion au CRM »). Afficher volume et difficulté dans le CMS demanderait une nouvelle intégration (clé API et
client), hors du périmètre « sans nouvelle dépendance ».
