# Fiche : « Ajouter à une pipeline » et « Passer en client »

Deux entrées en haut du menu **Actions** de la fiche, pour faire avancer un prospect sans quitter la fiche.

## Ajouter à une pipeline
- Je choisis la pipeline et l'étape. La fiche y est placée (même fiche, aucune copie) ; déjà dans une pipeline,
  la fenêtre montre sa position actuelle et la déplace. L'en-tête et Pipelines sont à jour aussitôt.
- Opportunité gagnée ou perdue : elle reste clôturée (la fenêtre renvoie vers « Rouvrir » / « Nouvelle opportunité »).

## Passer en client
- Même formulaire que « Marquer comme gagné » (date de clôture, signature, revenu ou « plus tard », projet), prérempli
  de la même façon. Si la fiche est hors pipeline, il demande aussi l'étape par laquelle passe la vente (par défaut
  la dernière étape de la première pipeline), comme dans le parcours normal.
- Résultat identique à Prospection → Pipeline → Gagné : fiche gagnée, vente dans Ventes, revenu dans Finance, projet
  « à préparer » avec sa préparation d'onboarding (Projets).
- Absent du menu pour une fiche déjà cliente (ou perdue : il faut d'abord la rouvrir).
- Sans contact sur la fiche : le projet est créé sans interlocuteur, la fenêtre le signale.

## Communs aux deux
- **Relances de campagne en cours** : la fenêtre demande de les arrêter ou de les garder, sans choix par défaut ;
  la base refuse si ce choix manque. Rien n'est envoyé à personne.
- **Prochaine action** : proposée (cochée s'il n'y a aucune tâche ouverte), elle devient une tâche de la fiche,
  visible dans l'Aperçu et dans Aujourd'hui.
- **Une seule opération** (`company_add_to_pipeline`, `company_make_client`) : étape, vente, revenu, projet et tâche
  sont enregistrés ensemble, ou rien. Double clic ou « Réessayer » : même clé, aucun doublon. Annuler : aucune écriture.
- Claude (connecteur MCP) : `move_company` et `make_client` appellent les mêmes fonctions ; `make_client` ne fait rien
  sans `confirmed_by_user=true` et pose les mêmes questions (étape, relances, projet ou revenu existant).

Migration : `supabase/migrations/20261117000100_fiche_pipeline_client.sql` (additive, après `20261116010400`).
