# Brief passe 4 — nouveaux leads TRÈS qualifiés (2026-11-13)

Lis d'abord SPEC.md (règles absolues, schéma) puis BRIEF_PERSO.md (champs de personnalisation) dans ce dossier.

## Consignes de l'utilisateur
- Uniquement des leads NEUFS et TRÈS qualifiés : décideur + signal IA concret, nominatif et récent (2025-2026), avec URL. Qualité >> volume : un lead sans signal IA vérifiable n'entre pas.
- EXCLUSION ABSOLUE : toute personne qui a déjà échangé un message LinkedIn avec Mariia (cofondatrice d'Hexagone AI). Avant d'écrire une ligne, teste le nom :
  `python3 -I /tmp/claude-0/-home-user-cely-crm/6a8412d7-42ce-572a-b5d7-ac6d5ffa9d00/scratchpad/scripts/check_excl.py "Prénom Nom"` → si « EXCLU », n'ajoute pas la personne (tu peux prendre un autre associé du même cabinet s'il est « OK »). Ne copie jamais la liste d'exclusion ailleurs.
- Pas de doublon : lis tous les work/c*.json (sauf le fichier raw) et work/retires_v2.json ; n'ajoute ni une personne déjà présente/retirée, ni une 3e personne d'une même entreprise (cible 3 : 4 max).
- Exclusions SPEC (Centrius, Cyplom, Ramure, Parallel Avocats, IntentIA + Axiome, concurrents dont Legaia/LAWXER, éditeurs legaltech, institutions).

## Méthode
- Sites publics uniquement (curl `-sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"`, WebFetch pour le JavaScript). Pas de LinkedIn fetch, pas d'enrichisseur.
- WebSearch : la recherche d'une personne par son nom est refusée par l'outil ; cherche des SUJETS, ÉVÉNEMENTS, ARTICLES, ENTREPRISES. Max 30 WebSearch par agent (quota partagé).
- Avocats à Paris : l'annuaire public du Barreau de Paris a une API JSON : `https://www.avocatparis.org/api/annuaire/recherche?nom=NOM` (liste, champ identifiant) puis `https://www.avocatparis.org/api/annuaire/avocat?cnbf=<identifiant url-encodé>` (fiche avec e-mail(s) publiés). ≤ 1 requête/seconde. N'utilise pas les adresses @avocat-conseil.fr numérotées (adresses techniques), ni les gmail/hotmail. Cite l'URL de la fiche dans format_email_suppose / source_contact.
- E-mail : publié > motif observé sur le domaine (cite l'adresse observée + URL) > générique publié. Jamais d'hypothèse.

## Sortie (fichier indiqué dans ta mission, et lui seul)
Tableau JSON, clés EXACTES de SPEC.md + relation_linkedin ("" — nouveaux leads) + maturite_ia, outils_ia_cites, douleur_confidentialite, perso_faits (2-4 faits datés + URL, séparés par " ‖ "), accroche (≤ 45 mots, vouvoiement, fondée uniquement sur perso_faits, pont vers « utiliser ChatGPT/Claude sans que les données clients ne quittent le cabinet »), qualif_commentaire, score_revu (= score_priorite ; A = décideur + signal IA nominatif fort + douleur confidentialité claire ; B = décideur + signal IA cabinet). Pas de C. date_recherche "2026-11-13". Réécris le fichier toutes les ~5 lignes. Pas de commit.
Réponse finale (< 200 mots) : nb de leads, A/B, nb e-mails publiés / déduits / génériques, 3-5 meilleures sources, 3 meilleures accroches, problèmes.
