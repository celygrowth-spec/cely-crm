# Spec commune — recherche de leads Hexagone AI (date de recherche : 2026-11-12)

## Le client
Hexagone AI (Boulogne-Billancourt, fondée 2025, HEC Incubator, Station F). Produit : permet aux avocats,
experts-comptables, juristes d'utiliser ChatGPT/Claude sans qu'aucune donnée client ne quitte le cabinet
(pseudonymisation locale avant envoi à l'IA, réidentification au retour ; on-premise/air-gapped possible).
Contexte : guide CNB « La déontologie et l'intelligence artificielle » (mars 2026) ; charte IA Barreau de Paris (juillet 2026).
NE PAS confondre avec « Hexagone » Strasbourg (Uniphore).

## Règles absolues
1. NE JAMAIS INVENTER une personne, un poste, un e-mail, une URL LinkedIn, un chiffre. Chaque ligne doit venir
   d'une page que tu as réellement vue (WebFetch du site du cabinet, ou résultat WebSearch). Si tu n'as pas
   trouvé une donnée → champ vide.
2. linkedin_url : uniquement une URL exacte apparue dans un résultat de recherche ou sur le site du cabinet
   (lien "LinkedIn" sur la fiche associé). Ne JAMAIS construire une URL linkedin.com/in/prenom-nom par déduction.
   Astuce : WebSearch "Prénom Nom cabinet linkedin" renvoie souvent l'URL linkedin.com/in/... exacte.
3. email : uniquement s'il est publié (fiche associé, mentions légales, page contact nominative). Adresses
   génériques (contact@, cabinet@) → les mettre dans la colonne email_generique, pas dans email.
   Jamais de gmail/hotmail/orange etc. Pas de portable.
4. format_email_suppose : si au moins UN e-mail nominatif du même domaine est publié (n'importe quel
   associé du cabinet), déduis le motif (ex. p.nom@domaine.fr) et applique-le → statut "déduit (motif observé sur
   X@domaine)". Sinon laisse vide ou écris "hypothèse non confirmée : prenom.nom@domaine" en précisant.
5. Décideurs uniquement : associé fondateur / associé gérant / managing partner / associé innovation-numérique
   (avocats) ; expert-comptable associé, dirigeant, DSI, resp. innovation (EC) ; directeur juridique, GC,
   DPO, legal ops (DJ) ; resp. practice IA/GenAI, associé Data&IA, partenariats (cible 3). Pas de juniors.
   Privilégie le fondateur / dirigeant.
6. Qualité > volume. Un cabinet doit avoir un SIGNAL concret (communication IA/legaltech/innovation,
   publication d'un associé sur l'IA ou le guide CNB, incubateur du Barreau, commission numérique,
   offre digitale, charte IA, etc.) avec URL. Sans signal → score C, et mieux vaut ne pas l'inclure si tu peux
   trouver mieux. Max 2 contacts par cabinet (sauf cible 3 : max 4).
7. Exclusions : Centrius, Cyplom, Ramure, Parallel Avocats, IntentIA (Hugo Salard) et cabinets qu'il forme ;
   concurrents (Anonym-IA, Lexanon, LexTandem, Sosie, Nonimo, Anoni, LaGomme, AnonymFiles, Docult, JurIAdoc,
   Jimini, Ordalie, Doctrine) ; institutions (CNB, barreaux, Ordre des EC, CROEC) ; legaltechs/éditeurs.
   Note : un cabinet CLIENT de Jimini/Ordalie/Doctrine est OK (c'est un signal), ce sont les éditeurs qui sont exclus.
8. Les faits datés (poste actuel) : vérifie qu'ils sont à jour (2025-2026 de préférence). Si l'info date
   d'avant 2025 et rien de récent ne la confirme → statut "à vérifier".
9. Pas de LinkedIn scraping, pas d'outil d'enrichissement : uniquement WebSearch + WebFetch de sites publics.
   (linkedin.com ne se fetch pas ; les URL viennent des résultats de recherche.)

## Sortie
Écris un fichier JSON (tableau d'objets) au chemin indiqué dans ta mission, avec EXACTEMENT ces clés :
cible (int), entreprise, site_web (domaine, ex. cabinet.fr), taille (+ source courte), ville,
specialite_secteur, prenom, nom, poste, linkedin_url, email, email_generique, format_email_suppose,
signal (1 phrase concrète), source_signal (URL), source_contact (URL où la personne/poste est confirmé),
perso_angle (pépite de personnalisation : tribune, post, citation — ou ""), score_priorite (A/B/C),
statut_verification ("vérifié" = poste+personne vus sur site officiel 2025-26 ; "déduit" ; "à vérifier"),
date_recherche ("2026-11-12").
Écris le fichier au fur et à mesure (réécris-le tous les ~10 contacts) pour ne rien perdre.
Score : A = signal IA fort et nominatif + décideur clé ; B = signal cabinet + décideur ; C = décideur sans signal fort.
En fin de mission, réponds en < 250 mots : nb de contacts, répartition A/B/C, 3-5 meilleures sources,
problèmes rencontrés, pépites de personnalisation les plus fortes.
