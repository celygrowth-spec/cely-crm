# Projet préparé automatiquement après « Gagné »

## Ce qui se passe quand je marque une vente gagnée

« Marquer comme gagné » (fiche, Kanban ou Ventes, voir `docs/ventes.md`) enregistre la vente, une par fiche,
et crée ou lie le projet client, en une seule transaction rejouable sans doublon. Dès que la vente porte un
projet, sa **préparation** existe (`project_onboarding`, déclencheur sur `sales`). Elle démarre en arrière-plan
(`prepareSale`, puis `onboarding_prepare`) et tient à jour l'état de la vente (`sales.prep`, `sales.prep_state`) :
la carte Ventes et le projet affichent le même nombre de points à compléter.

Dans le projet, l'onglet **Général** commence par le bloc **Préparer l'onboarding**. Le bandeau de suivi de
la vente (Devis / Contrat › Onboarding › En mission) reste en haut de tous les onglets et renvoie vers ce bloc.

Un projet lié à une vente plus ancienne reçoit sa préparation à la première ouverture. Un projet créé à la main,
sans vente, n'en a pas.

Si la préparation échoue, la vente et le projet restent enregistrés : le projet explique l'erreur et propose
**Relancer la préparation**.

## Ce que le CRM lit, ce qu'il ne lit pas

| Source | Lue par le CRM | Utilisée pour |
| --- | --- | --- |
| Fiche CRM (entreprise, description, montant, contacts) | oui | résumé de la mission, interlocuteurs |
| Appels Fireflies rattachés à la fiche | oui : résumés (et transcriptions pour Claude) | contexte, besoins, premières actions |
| Diagnostic : texte de la recherche, questions et réponses | oui | constats |
| Diagnostic : slides (.pptx) | non | — |
| Propositions, contrats (PDF, Word) | **non** : seuls le nom et la catégorie sont connus | choix de la proposition retenue |
| Lien vers une conversation Claude | non | — |

La proposition retenue : celle que j'ai choisie ; sinon le seul document « Contrat », sinon la seule
« Proposition ». S'il y en a plusieurs, le CRM me demande laquelle a été acceptée. Le diagnostic retenu :
le dernier qui a une version prête (le CRM n'a pas d'état « validé ») ; s'il y en a plusieurs, je peux en
choisir un autre.

Pour lire le contenu de la proposition et préremplir objectifs, périmètre, livrables et phases, le projet
propose **Lancer l'analyse** (tâche Claude automatique) ou **Analyser dans Claude** (lien). Claude passe
par le connecteur du CRM (`open_project_onboarding`, `save_project_onboarding_analysis`) : il cite ses
sources, signale les contradictions (deux options et leurs références) et ne remplace jamais une section
que j'ai corrigée.

## Le bloc « Préparer l'onboarding »

- **Points qui bloquent le démarrage**, numérotés : proposition acceptée, objectifs, périmètre et livrables,
  date de démarrage, interlocuteur. Chaque ligne propose son action : choisir un document déjà joint,
  importer le document signé, renseigner la date, répondre, choisir entre deux options, marquer non applicable.
- **Compléments facultatifs** (repliés) : appels non rattachés, diagnostic absent, email manquant.
- **Demande au client** : je relis le texte, puis **Partager sur le portail**. La demande devient une tâche
  visible du client (projet publié requis). Sa réponse en commentaire, le fichier déposé sur la tâche ou la
  tâche marquée faite mettent le point à jour (« Reçu du client »). Aucun email n'est envoyé.
- **Relancer la préparation** conserve mes corrections (sections marquées « Corrigé par vous ») et mes réponses.

Quand plus rien ne bloque : **Prêt à démarrer** et **Générer les slides d'onboarding**.

## Slides d'onboarding

Le CRM ne fabrique pas de PowerPoint lui-même : comme pour le Diagnostic, c'est Claude qui le génère à
partir du projet vérifié (et du modèle Cely de la bibliothèque du Diagnostic, catégorie « Marque », s'il
existe), puis le dépose (`start_onboarding_deck_upload`, `confirm_onboarding_deck_upload`). Chaque version
arrive dans le dossier interne **Onboarding (interne)** du projet. Je peux la télécharger, demander une
nouvelle version, et **Partager cette version** : elle passe à la racine des fichiers du projet (les autres
restent internes). Rien n'est partagé sans ce clic.

## Tâche Claude automatique (facultatif)

1. Sur claude.ai/code/routines, créer une tâche avec le connecteur du CRM et cette consigne :
   « Le texte reçu a la forme `onboarding:analyse:<projet>` ou `onboarding:slides:<projet>`. Appelle
   open_project_onboarding avec l'identifiant. Pour `analyse` : lis la proposition retenue
   (get_project_onboarding_document_url), les appels et le diagnostic, puis save_project_onboarding_analysis.
   Pour `slides` : génère le PowerPoint d'onboarding (objectifs, périmètre, étapes, livrables, rôles,
   prochaines actions) et dépose-le. En cas de blocage : report_project_onboarding_failure. »
2. *Add another trigger › API* : copier l'adresse `/fire` et le jeton.
3. Dans Vercel, ajouter `ONBOARDING_ROUTINE_URL` et `ONBOARDING_ROUTINE_TOKEN`, puis redéployer.

Sans ces deux valeurs, tout fonctionne avec les liens vers Claude.

## Sécurité

Préparation, points, sections et versions de slides sont réservés au propriétaire connecté (RLS, aucun droit
pour `anon`, aucune fonction `portal_*`). Le client ne voit que les demandes que j'ai partagées et la version
de slides que j'ai partagée. Tests : `tests/db/projet-onboarding.test.ts`. Migration : `supabase/migrations/20261114000100_projet_onboarding.sql`.
