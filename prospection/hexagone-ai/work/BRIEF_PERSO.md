# Brief passe 2 — qualification + personnalisation (2026-11-12)

Contexte : lis SPEC.md (le client Hexagone AI, les règles absolues). Les contacts existent déjà dans les fichiers JSON qui te sont attribués. Tu ne changes PAS la liste (pas d'ajout) ; tu ENRICHIS chaque ligne.

## Règles absolues (rappel)
- Ne JAMAIS inventer un fait, une citation, une date, un chiffre, une URL. Chaque fait de personnalisation = une URL que tu as réellement ouverte (curl / WebFetch) ou vue en résultat WebSearch.
- Citations : mot pour mot, entre « », uniquement si tu les as lues sur la page.
- Faits récents de préférence (2025-2026). Indique la date (mois/année) quand elle est visible.
- Accès : `curl -sL -m 25 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" URL` marche depuis Bash ; WebFetch aussi (utile pour les sites en JavaScript). Écris tes fichiers temporaires dans /tmp/claude-0/-home-user-cely-crm/6a8412d7-42ce-572a-b5d7-ac6d5ffa9d00/scratchpad/<ton_nom>/. Lis le HTML avec `python3 -I`.
- WebSearch : MAX 30 pour toi (quota partagé entre 5 agents). Utilise-le pour trouver des articles, interviews, tribunes, podcasts, conférences de la personne (« Prénom Nom » + IA / intelligence artificielle / ChatGPT / tribune / interview / podcast).

## Où chercher (par personne)
1. Fiche de la personne + blog / actualités du cabinet (articles signés, 12 derniers mois).
2. Presse pro : village-justice.com, lemondedudroit.fr, actu-juridique.fr, decideurs-juridiques, LJA, compta-online.com, profession-comptable, Les Echos Solutions, maddyness, journaldunet, usine-digitale (cible 3).
3. Podcasts (Ausha, Spotify, Apple), webinars, conférences (Legal Tech Days, Congrès de l'Ordre des EC, VivaTech, AI Summit), prix (JINOV, Trophées du Droit), livres.
4. Page entreprise : levées, recrutements, nouvelles offres IA, communiqués 2026, clients cités, outils IA utilisés (Doctrine, Jimini, Ordalie, Harvey, Legora, Copilot, ChatGPT Enterprise, Claude, Mistral, Pennylane, etc.).

## Champs à AJOUTER à chaque objet (clés exactes, valeurs string)
- `maturite_ia` : "0" (aucune trace), "1" (parle d'IA / publie dessus), "2" (utilise un outil IA nommé), "3" (a construit / déploie / vend une IA). Suivi de " — " + justification courte. Ex. "3 — a lancé son IA interne OBBOT (sept. 2026)".
- `outils_ia_cites` : outils IA nommés publiquement par la personne ou le cabinet, séparés par « , » ("" si aucun).
- `douleur_confidentialite` : la tension concrète entre IA et confidentialité / secret pro chez CE prospect, prouvée par une source si possible (ex. « interdit d'entrer des noms dans son IA interne », « données de santé des salariés », « clients private equity sous NDA », « secteur défense classifié »). Sinon la déduire du métier en le signalant par « (déduit du métier) ».
- `perso_faits` : 2 à 4 faits de personnalisation, séparés par " ‖ ", chacun au format « fait précis (mois année) — URL ». Priorité : ce que la personne a DIT ou ÉCRIT elle-même (tribune, post de blog, interview, podcast, conférence), puis actualité du cabinet (lancement, prix, recrutement, levée, nouveau bureau), puis éléments plus personnels mais publics (parcours, livre, enseignement, association).
- `accroche` : 1 à 2 phrases d'accroche d'e-mail en français, vouvoiement, ≤ 45 mots, qui s'appuient UNIQUEMENT sur perso_faits, ne flattent pas lourdement, et font le pont vers le problème qu'Hexagone résout (utiliser ChatGPT/Claude sans que les données clients ne quittent le cabinet). Pas de nom de produit dans la 1re phrase.
- `qualif_commentaire` : 1 phrase de qualification : décideur confirmé ? taille confirmée ? budget / contexte ? risque (ex. président d'Ordre, éditeur concurrent, vient de signer avec un concurrent) ? Si la ligne devrait être retirée, commence par « À RETIRER : » + raison (je déciderai).
- `score_revu` : A / B / C revu selon les nouvelles infos (A = signal IA nominatif fort + décideur + douleur confidentialité claire).

Tu peux aussi CORRIGER un champ existant si tu trouves une erreur (poste, e-mail, orthographe, URL morte) : dans ce cas ajoute la correction dans qualif_commentaire (« Corrigé : … »). Ne supprime aucune ligne.

## Méthode et livraison
- Réécris ton/tes fichier(s) toutes les ~5 lignes (json.dump ensure_ascii=False, indent=1) pour ne rien perdre. N'écris QUE dans tes fichiers. Pas de git.
- Réponse finale (< 250 mots) : nb de lignes enrichies, répartition maturite_ia 0/1/2/3, scores revus (combien montent / descendent), lignes « À RETIRER » avec raison, corrections faites, et les 5 meilleures accroches (prospect + accroche).
