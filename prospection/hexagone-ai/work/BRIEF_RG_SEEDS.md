# Brief passe 5b — qualifier des noms de départ (2026-11-13)

Lis d'abord SPEC.md, BRIEF_PERSO.md et BRIEF_V4.md (règles, exclusion Mariia, API Barreau de Paris, format de sortie) dans ce dossier.

## Entrée
Ta tranche : /tmp/claude-0/-home-user-cely-crm/6a8412d7-42ce-572a-b5d7-ac6d5ffa9d00/scratchpad/uploads_rg/seed_slice_N.json — uniquement des NOMS de départ (prénom, nom, structure, poste déclaré, métier), sans aucune coordonnée. Tout ce qui entre dans ta sortie doit être RETROUVÉ par toi sur des sources publiques, avec l'URL réelle : si tu ne retrouves pas publiquement la personne dans sa structure, ÉCARTE-la. NE copie jamais ce fichier dans le dépôt ; ne mentionne jamais l'origine de la piste dans les champs de sortie.

## Pour chaque piste
1. Test d'exclusion Mariia (check_excl.py) et absence dans work/c*.json et work/retires_v2.json.
2. Cible Hexagone : avocat associé/fondateur de cabinet 5-50 avocats (1), expert-comptable associé/dirigeant (2), directeur juridique / GC / DPO / legal ops / responsable compliance ou fiscal d'une entreprise française (4). Un juriste junior ou un salarié non décideur → écarter (sauf legal ops / innovation juridique d'un grand groupe = porte d'entrée, score B max).
3. Vérifie personne + poste sur une source officielle 2025-26 (site, communiqué, programme du salon avec l'URL, annuaire du Barreau de Paris).
4. Cherche un SIGNAL IA concret (personne ou organisation) avec URL : intervention sur l'IA (beaucoup d'intervenants du salon parlent d'IA : cite la session et l'URL du programme), article, outil IA déployé, projet legal tech. Score A = décideur + signal IA nominatif + douleur confidentialité claire ; B = décideur + signal IA de l'organisation ou intervention sur la transformation numérique. Sans aucun signal → écarter (pas de C).
5. E-mail : publié (site / annuaire BdP) > motif observé sur le domaine (cite l'adresse observée + URL) > générique publié.
6. Personnalisation (BRIEF_PERSO) : perso_faits, accroche Hexagone (≤ 45 mots), douleur_confidentialite, maturite_ia, outils_ia_cites, qualif_commentaire.
7. (pas de contrainte de date d'envoi)
8. relation_linkedin = "".

Sortie : le fichier indiqué dans ta mission (schéma de BRIEF_V4), date_recherche "2026-11-13". Max 20 WebSearch. Réponse finale (< 150 mots) : traités / retenus / écartés (raisons), A/B, e-mails publiés/déduits/génériques, 3 meilleures accroches.
