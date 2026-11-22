# Modèle d'article pour le CMS (fichier .md à importer)

Un article = un fichier `.md` : un en-tête (frontmatter) entre deux lignes `---`, puis le contenu en Markdown avec
les blocs ci-dessous. Importé dans **CMS › Articles › Importer**, il s'affiche sur celygrowth.com avec exactement le
design des articles existants. Autour du contenu, le site ajoute seul : en-tête et partage, bloc auteur avec les dates,
« Réponse directe » et « À retenir » en haut, sommaire, encadré « Premier échange offert », tags, carte auteur et
« À lire ensuite ».

## En-tête

```yaml
---
title: "Le cold emailing est-il mort en 2026 ?"
slug: "cold-emailing-2026"
excerpt: "Ce qui marche encore, ce qui ne marche plus, et par quoi le remplacer en B2B."
category: "Growth marketing B2B"
tags: ["Prospection", "Cold emailing", "Stratégie B2B"]
author: "Célien Boillot"
cover_image: "https://…/couverture.webp"
cover_alt: "Une boîte de réception saturée"
focus_keyword: "cold emailing 2026"
secondary_keywords: ["prospection email", "délivrabilité"]
seo_title: "Cold emailing en 2026 : est-ce encore rentable ?"
seo_description: "Coût, délivrabilité, taux de réponse : ce qui marche encore en cold emailing B2B en 2026, et les alternatives."
status: "scheduled"
publish_at: "2026-12-01 09:00"
---
```

- `title` est obligatoire ; les autres champs manquants sont signalés à l'import.
- `slug` : minuscules, chiffres et tirets. Sans slug, il est créé à partir du titre.
- `status` : `draft` (brouillon, par défaut), `scheduled` (programmé, avec `publish_at`), `published`.
- `publish_at` : heure de Paris (`2026-12-01 09:00`) ou date ISO complète.
- Images : une adresse complète, ou un nom de fichier local (`couverture.webp`) en joignant l'image au moment de
  l'import (elle part dans le stockage).
- `seo_title` (~60 caractères) et `seo_description` (~155) : vides, ils reprennent le titre et l'extrait.

## Contenu

Le premier paragraphe est l'accroche (mise en avant). Titres de section en `##` (ils forment le sommaire), sous-titres
en `###`. Gras `**…**`, italique `*…*`, liens `[texte](https://…)`, listes, tableaux Markdown.

Image avec légende : seule dans son paragraphe, avec la légende entre guillemets.

```markdown
![Schéma du parcours froid, tiède, chaud](https://…/parcours.png "Un lead magnet fait franchir la première marche.")
```

## Blocs

Un bloc commence par `:::nom` et se termine par `:::` seul sur sa ligne. Le contenu est du Markdown.

| Bloc | Rendu |
| --- | --- |
| `:::reponse` | Encadré « Réponse directe » (placé en haut de l'article) |
| `:::retenir` | Encadré « À retenir », en général une liste (placé en haut de l'article) |
| `:::conseil Titre` | Encadré violet « Conseil Cély » avec un titre (facultatif) |
| `:::attention Titre` | Encadré d'avertissement |
| `:::resume Titre` | Encadré de synthèse |
| `:::conseil Titre \| Étiquette` | Même chose avec une autre étiquette que « Conseil Cély » |
| `:::citation` | Phrase mise en avant (trait violet) |
| `:::postit` | Post-it « Culture générale » (`:::postit Autre libellé` pour le changer) |
| `:::definition` | Définition mise en valeur |
| `:::faq` | FAQ : chaque question en `###`, la réponse dessous. Données structurées Google ajoutées seules |
| `:::outil nom` | Un outil interactif du site (liste ci-dessous) |

Outils disponibles :

| Nom | Outil |
| --- | --- |
| `simulateur-inbound-outbound` | Simulateur « Inbound ou outbound ? » |
| `generateur-prompts` | Générateur de prompts de test (référencement IA) |
| `audit-geo` | Formulaire de demande d'audit GEO |
| `diagnostic-aarrr` | Diagnostic AARRR |
| `generateur-lead-magnet` | Générateur de lead magnet |

Le HTML n'est pas pris en charge : tout ce qui n'est pas Markdown ou un bloc de cette liste s'affiche comme du texte.

## Exemple complet

```markdown
---
title: "Le cold emailing est-il mort en 2026 ?"
category: "Growth marketing B2B"
tags: ["Prospection", "Cold emailing"]
excerpt: "Ce qui marche encore, ce qui ne marche plus, et par quoi le remplacer en B2B."
status: "draft"
---
Tout le monde l'enterre chaque année. Et chaque année, il est encore là.

:::reponse
Le cold emailing n'est pas mort, mais il est devenu le canal au pire rapport effort/résultat pour la plupart des PME B2B.
:::

:::retenir
- **Le coût d'entrée a explosé** : domaines, préchauffage, délivrabilité.
- **Les boîtes sont saturées** par les emails générés par IA.
- **Le signal vaut mieux que le volume** : visites, recrutements, levées de fonds.
:::

## Pourquoi il s'essouffle

Les boîtes de réception reçoivent trois fois plus de messages qu'en 2023.

:::citation
100 contactés → 25 réponses → 2 rendez-vous → 1 client
:::

:::conseil Ce que je ferais à votre place
Commencez par LinkedIn et les signaux d'intention avant d'acheter un seul domaine secondaire.
:::

## Votre diagnostic

:::outil diagnostic-aarrr
:::

## FAQ

:::faq
### Le cold emailing est-il légal en B2B ?
Oui, à condition de respecter le RGPD : intérêt légitime, information claire et désinscription facile.

### Combien d'emails envoyer par jour ?
Assez peu pour rester sous les radars : quelques dizaines par boîte, jamais des centaines.
:::

## Conclusion

Le canal n'est pas mort ; c'est l'envoi en masse qui l'est.
```
