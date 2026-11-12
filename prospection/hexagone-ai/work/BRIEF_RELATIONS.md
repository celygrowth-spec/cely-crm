# Brief passe 3 — qualifier les relations LinkedIn de Mariia (2026-11-12)

Lis d'abord SPEC.md (règles absolues, schéma JSON) et BRIEF_PERSO.md (champs de personnalisation) dans ce dossier.

## Données d'entrée (CONFIDENTIELLES)
Ta tranche : /tmp/claude-0/-home-user-cely-crm/6a8412d7-42ce-572a-b5d7-ac6d5ffa9d00/scratchpad/relations/slice_N.json (N indiqué dans ta mission). Chaque objet = une relation LinkedIn de Mariia Zameshina (cofondatrice d'Hexagone AI), avec : cible (classement automatique par mots-clés, À VÉRIFIER), prenom, nom, entreprise, poste (tels que déclarés sur LinkedIn), linkedin_url, email_relation (e-mail partagé par la relation avec ses contacts, parfois vide), echange (a répondu / sans réponse / message entrant / aucun message / suivi), msgs_mariia, msgs_recus, dernier_echange. Triée des plus chaudes aux plus froides.
NE copie JAMAIS le fichier d'entrée dans le dépôt. Pas de commit. Ne fetch pas linkedin.com. La WebSearch refuse d'identifier une personne par son nom : ne cherche que des ENTREPRISES / cabinets / sites.

## Pour chaque relation (dans l'ordre du fichier)
1. Vérifie la cible : avocat d'affaires dans un cabinet français (cible 1) / expert-comptable (2) / cabinet de conseil-ESN partenaire IA (3) / juriste-DJ-DPO-legal ops d'une entreprise française (4). Écarte : hors France, étudiants, recruteurs, éditeurs legaltech, institutions, exclusions de la SPEC, grands cabinets > 50 avocats sans signal IA nominatif (cible 1), postes non décisionnaires sans intérêt (ex. juriste junior d'une PME → écarter ; juriste d'un grand groupe = porte d'entrée, garde en C).
2. Trouve le site officiel de l'entreprise (devine le domaine et vérifie par curl ; WebSearch sur le NOM DE L'ENTREPRISE si besoin). Confirme la personne et son poste sur le site (page équipe) si possible → statut "vérifié" ; sinon le poste vient du profil LinkedIn déclaré → statut "déduit" et source_contact = "profil LinkedIn (export relations de Mariia)" + linkedin_url.
3. Taille (site / mentions légales / Pappers via curl), ville, spécialité.
4. Signal IA concret de la personne ou de l'entreprise (blog, actus, offre IA, outil cité), avec URL. Pas de signal IA → note la relation chaude comme seul signal.
5. E-mail : publié sur le site (fiche / contact / mentions) > motif observé sur le domaine (format_email_suppose, avec l'adresse observée et l'URL) > générique publié. Si email_relation est sur un domaine PROFESSIONNEL (pas gmail/hotmail/orange/yahoo/icloud/outlook.fr/free…), tu peux le mettre dans email avec la mention "source : export relations LinkedIn de Mariia" dans format_email_suppose. Jamais d'hypothèse non confirmée.
6. Personnalisation légère (BRIEF_PERSO) : maturite_ia, outils_ia_cites, douleur_confidentialite, perso_faits (1-3 faits sourcés), accroche (≤ 45 mots ; si la personne a déjà échangé avec Mariia, l'accroche peut faire référence à « notre échange » sans inventer son contenu), qualif_commentaire, score_revu.
7. relation_linkedin : décris l'historique, ex. « relation LinkedIn de Mariia ; a répondu (2 envoyés / 1 reçu, dernier 2026-05-27) → relance tiède : relire l'échange avant » ; « 3 messages LinkedIn sans réponse (dernier 2026-06-10) → passer par e-mail avec un autre angle » ; « relation sans échange → premier contact ».

## Score
A = décideur + signal IA concret (personne ou cabinet) + (relation chaude ou douleur confidentialité claire) ; B = décideur + (signal IA OU relation qui a répondu) ; C = décideur sans signal, ou non-décideur dans une cible intéressante. Max 2 contacts par entreprise. N'inclus pas une ligne sans entreprise identifiable.

## Sortie
Un fichier JSON (indiqué dans ta mission) : tableau d'objets avec EXACTEMENT les clés de SPEC.md + relation_linkedin + maturite_ia, outils_ia_cites, douleur_confidentialite, perso_faits, accroche, qualif_commentaire, score_revu ; score_priorite = score_revu ; date_recherche "2026-11-12". Réécris-le toutes les ~5 lignes. Avant d'ajouter, vérifie qu'entreprise/personne n'est pas déjà dans un work/c*.json (ou dans les fichiers c5*.json d'autres agents).
Vise la QUALITÉ : mieux vaut 25 lignes solides que 60 approximatives, mais traite toute ta tranche (écarte vite ce qui est hors cible). WebSearch : max 25 (quota partagé). Réponse finale (< 200 mots) : nb traités / retenus / écartés (par raison), A/B/C, nb avec e-mail (publié / déduit / relation / générique), 3 meilleures accroches.
