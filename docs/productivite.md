# Productivité : Temps et To do list

Menu **Productivité**, deux sous-pages :

- **Temps** (`/productivite/temps`) : le suivi du temps, inchangé (voir `suivi-du-temps.md`). L'ancienne adresse
  `/temps` redirige, paramètres compris (liens du chrono, favoris).
- **To do list** (`/productivite/todo`) : une liste simple, indépendante des tâches de fiche, de projet et de
  prospection (Aujourd'hui, compteur du menu, MCP : rien ne change pour elles).

## To do list

- **Ajouter** en une ligne : titre, urgence (**Urgent**, **Moyen** par défaut, **Pas urgent**), fiche liée
  facultative (client ou prospect, choisie par recherche). Un double clic ou une double validation ne crée qu'une
  tâche : l'identifiant est fixé au moment de la saisie (`todo_list_create`).
- **Ordre** : Urgent, puis Moyen, puis Pas urgent ; à urgence égale, la plus récente d'abord.
- **Cocher** termine la tâche : elle passe dans **Terminées** (repliée), d'où on la décoche.
- **Modifier sur place** : titre (Entrée ou clic ailleurs pour enregistrer, Échap pour annuler), urgence, fiche
  liée (Changer, Retirer). Le nom de la fiche ouvre la fiche.
- **Supprimer** : par la Corbeille (type « Tâche de la To do list »), restaurable 30 jours.
- **Sur la fiche** (Aperçu) : les tâches ouvertes de la To do list liées à la fiche, à cocher sur place.
- **Échec d'enregistrement** : message clair, saisie conservée ; rien n'est affiché comme enregistré tant que la
  base n'a pas répondu.

## Fiche liée

| Situation | Effet sur la tâche |
| --- | --- |
| Fiche archivée | la tâche reste liée, le nom porte « (archivée) » |
| Fiche à la corbeille | la tâche reste ; « Fiche à la corbeille », sans lien ; le lien revient à la restauration |
| Fiche purgée de la corbeille | la tâche reste, sans fiche |
| Fusion (Doublons) | le lien passe sur la fiche conservée |

## Garanties en base (`20261118004500_todo_list.sql`)

- Table `todo_list_items` (la vue `todo_items` d'Aujourd'hui est autre chose et n'est pas modifiée).
- Urgence limitée à `urgent`, `moyen`, `pas_urgent` ; titre de 1 à 300 caractères ; une fiche au plus.
- Fiche liée : seulement une fiche visible et non absorbée par une fusion (identifiant inconnu ou manipulé refusé).
- Accès : propriétaire, dans l'application. Ni le portail client, ni un autre compte, ni Claude (MCP).
- Corbeille : les types d'éléments sont inscrits dans `trash_private.kinds` (au lieu d'une liste en dur) ; la
  migration y recopie les types existants. Une branche qui ajoute un type de corbeille l'inscrit dans cette table.
