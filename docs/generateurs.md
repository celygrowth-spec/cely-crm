# Générateurs : proposition et onboarding

Même logique que le diagnostic, à chaque fois : sources rassemblées, questions pré-remplies, génération d'une
version, relecture, validation, envoi. Le code commun est dans `src/lib/generators` et `src/components/generator`.

## Parcours et prochaine action
Chaque client a une seule prochaine action principale, déduite de ses documents (jamais d'une étape de pipeline) :

| État | Ce qui le déclenche | Bouton |
| --- | --- | --- |
| Appel fait | appel Fireflies rattaché, ou rendez-vous passé | Générer un diagnostic |
| Diagnostic | dossier de diagnostic ouvert | Voir le diagnostic |
| Diagnostic validé | « Valider le diagnostic » sur une version reçue | Générer la proposition |
| Proposition | dossier de proposition ouvert | Voir la proposition, puis Envoyer la proposition une fois validée |
| Proposition envoyée | envoi par le module Mail (ou « Déjà envoyée autrement ») | Voir la proposition |
| Signée | retour « devis signé » de Make, ou « Marquer comme signée » | Passer en client, puis Générer l'onboarding |
| Onboarding | dossier d'onboarding ouvert sur le projet | Voir l'onboarding |

Le bouton apparaît sur la fiche, la carte du Pipeline, la carte Ventes, à la fin du livrable précédent, après un
appel (fiche, rendez-vous passé, et dès le rattachement dans Appels) et dans Accueil › Prochaines actions clients.
Dans l'accueil, « Diagnostic à générer » ne revient que pour un appel de moins de 30 jours.

## Contenus à relire, modifiables sans toucher à la logique
- `src/content/generators/proposition.ts` et `onboarding.ts` : questions, aides, choix, ordre, caractère obligatoire.
  `make: true` : la réponse part à Make pour le devis. `internal: true` : elle ne part pas à l'IA.
- Paramètres › Générateurs : sélection par défaut de la bibliothèque, par générateur (au départ : la charte
  « Marque et design » de la bibliothèque de diagnostic). Ajustable dossier par dossier.

## Tâches Claude
- **Proposition** : une tâche Claude Code dédiée, avec un déclencheur API (`PROPOSITION_ROUTINE_URL`,
  `PROPOSITION_ROUTINE_TOKEN`). Le CRM lui envoie `proposition:preremplissage:<id>` puis `proposition:slides:<id>`.
  Consigne suggérée pour la tâche : « Tu reçois un texte de la forme proposition:<étape>:<identifiant>. Avec le
  connecteur du CRM Cely, appelle open_proposal avec cet identifiant, puis suis les consignes qu'il renvoie. »
  Elle doit pouvoir joindre le domaine Supabase, comme celle du diagnostic.
- **Onboarding** : la tâche existante des projets (`ONBOARDING_ROUTINE_*`), sans changement. `open_project_onboarding`
  lui donne en plus le questionnaire d'onboarding et la proposition signée.
- Sans tâche configurée : l'écran propose le lien vers Claude et le message à copier.

## Garde-fous (en base)
- Créer un dossier, répondre en tant que propriétaire, générer, valider, envoyer, signer et appeler Make : dans
  l'application seulement. Les outils MCP (`open_proposal`, `read_proposal_source`, `save_proposal_answers`,
  `start_proposal_version`, `confirm_proposal_version`, `report_proposal_failure`) n'en font aucun.
- Claude ne lit que les sources retenues de la fiche du dossier, jamais les coordonnées de facturation, et ne propose
  jamais de montant. Une réponse saisie par le propriétaire n'est jamais remplacée.
- Une version validée est figée. Une version = un devis au plus ; un devis inchangé est repris par la version suivante.
- Signature : Make ou « Marquer comme signée », un seul résultat. Après un retour de Make, le passage en client se
  fait à la prochaine ouverture du CRM (la route de Make n'a pas de session), par la logique existante et sous une
  clé liée au devis. S'il ne se déduit pas entièrement (fiche hors pipeline, projet ou revenu déjà présents), il
  reste à confirmer avec « Passer en client ».
- Onboarding : rien n'est visible du client avant la validation ; les tâches créées ne lui sont pas visibles, et le
  partage des slides reste l'action explicite existante.

## Limites connues
- La case « Offre découverte » n'existe pas encore sur la fiche client : rien n'est coché quand la proposition
  contient cette offre (`hasDiscoveryOffer` est prêt pour le jour où la case existera).
- Le CRM ne contient que les emails qu'il a envoyés : les emails reçus ne font pas partie des sources.
- Les slides d'onboarding restent en PowerPoint (circuit existant) ; celles de la proposition sont en PDF.

Contrat avec Make : `docs/integrations/make.md`.
