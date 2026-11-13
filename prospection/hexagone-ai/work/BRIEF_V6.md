# Brief passe 6 — plus de leads CONTACTABLES (2026-11-13)

Lis d'abord SPEC.md, BRIEF_PERSO.md et BRIEF_V4.md (règles absolues, exclusion Mariia via check_excl.py, dédoublonnage, API du Barreau de Paris, format de sortie). Tout s'applique, avec ces changements :

1. **E-MAIL OBLIGATOIRE** : n'ajoute une personne que si tu as une adresse utilisable : nominative publiée (site, mentions légales, annuaire du Barreau de Paris), OU déduite d'un motif RÉELLEMENT observé sur le même domaine (cite l'adresse observée + l'URL dans format_email_suppose), OU à défaut une adresse générique publiée de la structure (contact@…). Pas d'adresse = pas de ligne.
2. **Score** : A ou B si signal IA sourcé (comme avant). Si le décideur est vérifié et a un e-mail mais AUCUN signal IA public : ajoute-le quand même en score C avec qualif_commentaire commençant par « TEST À FROID : décideur dans la cible, sans signal IA public. », maturite_ia « 0 — aucune trace publique », perso_faits "", et une accroche liée au métier, sans aucun fait inventé :
   - avocat : « Le guide du CNB de mars 2026 encadre désormais l'usage de l'IA par les avocats : comment {cabinet} permet-il à ses équipes d'utiliser ChatGPT ou Claude sur des dossiers clients sans que ces données ne quittent le cabinet ? »
   - expert-comptable : « Secret professionnel et RGPD s'appliquent aussi aux données envoyées à ChatGPT ou Claude : comment {cabinet} encadre-t-il ces usages sur les dossiers de vos clients ? »
   - direction juridique : « Contrats, notes et avis juridiques sont parmi les données les plus sensibles de {entreprise} : comment vos équipes peuvent-elles utiliser ChatGPT ou Claude sans qu'ils sortent de l'entreprise ? »
3. Décideurs uniquement (associé / fondateur / dirigeant / directeur juridique / DPO / legal ops lead). Cabinets d'avocats 5-50 avocats ; cabinets EC 10-300 personnes ; entreprises françaises. Max 2 par structure.
4. Vise le VOLUME utile : traite vite, une ligne bien sourcée vaut mieux qu'une recherche approfondie. Max 20 WebSearch ; utilise surtout curl / WebFetch des sites et l'API du Barreau de Paris (≤ 1 requête/s).
Sortie : le fichier indiqué dans ta mission (schéma BRIEF_V4 + relation_linkedin ""), date_recherche "2026-11-13", réécrit toutes les ~5 lignes. Pas de commit. Réponse finale (< 120 mots) : nb ajoutés, A/B/C, e-mails publiés/déduits/génériques.
