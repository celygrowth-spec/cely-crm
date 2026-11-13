# Hexagone AI — Vague 1 (79 contacts, tous inconnus de Mariia) — séquences prêtes à importer

Expéditrice : **Mariia Zameshina, cofondatrice d'Hexagone AI**, depuis la boîte Hexagone AI (PAS depuis un autre compte).
Fichier : `Hexagone_AI_vague1_leads.csv` (colonnes = variables Lemlist : `{{firstName}}`, `{{lastName}}`, `{{companyName}}`, `{{salutation}}`, `{{ligne_attention}}`, `{{accroche}}`, `{{douleur_confidentialite}}`…).
Règle d'or : l'accroche de chaque contact est déjà écrite et sourcée (colonne `accroche`, faits dans `perso_faits`). Ne pas la réécrire, ne rien ajouter qu'on ne peut pas prouver.

| Segment | Nb | Qui | Canal |
|---|---|---|---|
| C_cabinet_premier_contact | 48 | avocats et experts-comptables score A, jamais contactés | e-mail + invitation LinkedIn |
| P_partenaire_anthropic | 18 | décideurs chez les partenaires Claude (KPMG, Capgemini, IBM, Bain, BCG, Sia, SFEIR, Wesype, Galadrim…) | e-mail (angle partenariat) + invitation LinkedIn |
| D_direction_juridique | 13 | DJ / DPO / legal ops de groupes | e-mail + invitation LinkedIn |

Consigne : aucun contact ayant déjà échangé un message LinkedIn avec Mariia (ils ont été retirés de la base).

Rythme : 15 à 20 premiers e-mails par jour maximum, du mardi au jeudi, 8h30–10h30. Arrêt automatique sur réponse.

---

## Segment C — cabinets (avocats, experts-comptables), premier contact

**J0 · E-mail 1**
Objet : `{{companyName}} : ChatGPT et Claude sans exposer vos dossiers`

> {{ligne_attention}}
>
> {{salutation}},
>
> {{accroche}}
>
> Hexagone AI pseudonymise vos documents sur votre poste, avant tout envoi à ChatGPT ou Claude, puis remet les vrais noms dans la réponse : le modèle ne voit jamais l'identité d'un client. Le déploiement peut aussi se faire sur vos propres serveurs, sans connexion externe.
>
> Seriez-vous partant(e) pour 20 minutes de démonstration, sur un document de votre choix ?
>
> Mariia Zameshina
> Cofondatrice, Hexagone AI — HEC Incubator, Station F

**J2 · LinkedIn** : invitation sans note (depuis le compte de Mariia).

**J5 · E-mail 2 (même fil)**
> {{salutation}},
>
> Je me permets de revenir vers vous avec un élément concret : le guide du CNB « La déontologie et l'intelligence artificielle » (mars 2026) et la charte IA du Barreau de Paris (juillet 2026) rappellent qu'aucune donnée couverte par le secret ne doit être transmise à un outil d'IA sans garanties. La pseudonymisation locale permet justement de garder ces outils, sans transférer l'identité des clients.
>
> Un créneau de 20 minutes vous conviendrait-il cette semaine ou la suivante ?
>
> Mariia

*(Pour les experts-comptables, remplacer la 1re phrase par : « le secret professionnel de l'expert-comptable et le RGPD s'appliquent aussi aux données envoyées à ChatGPT ou Claude. »)*

**J12 · E-mail 3 (même fil, dernier)**
> {{salutation}},
>
> Je ne voudrais pas encombrer votre boîte : je clos ce fil. Si la question de l'IA et du secret professionnel revient chez {{companyName}}, il suffit de répondre à ce message et je vous montre l'outil en 20 minutes.
>
> Bonne continuation,
> Mariia

---

## Segment P — partenaires Anthropic (18) : angle partenariat

**J0 · E-mail 1**
Objet : `Claude chez vos clients réglementés : une brique de pseudonymisation`

> {{ligne_attention}}
>
> {{salutation}},
>
> {{accroche}}
>
> Hexagone AI est une brique de pseudonymisation locale et réversible : les documents sont pseudonymisés avant l'appel à Claude et réidentifiés au retour, déployable sur site. C'est souvent ce qui débloque un projet Claude chez un cabinet d'avocats, un expert-comptable ou une direction juridique.
>
> Seriez-vous ouvert(e) à un échange de 30 minutes pour voir si une intégration ou une co-vente a du sens pour {{companyName}} ?
>
> Mariia Zameshina
> Cofondatrice, Hexagone AI — HEC Incubator, Station F

**J2 · LinkedIn** : invitation sans note.

**J6 · E-mail 2**
> {{salutation}}, pour être concrète : nous pouvons faire une démo technique à votre équipe (API, déploiement sur site), et regarder ensemble un projet client où la confidentialité bloque aujourd'hui. Un créneau la semaine prochaine ?
> Mariia

**J13 · E-mail 3 (dernier)** : « Je clos ce fil ; si un projet Claude bute sur la confidentialité chez un de vos clients, je reste disponible. »

---

## Segment D — directions juridiques (13)

**J0 · E-mail 1**
Objet : `IA générative et confidentialité à la direction juridique de {{companyName}}`

> {{ligne_attention}}
>
> {{salutation}},
>
> {{accroche}}
>
> Hexagone AI pseudonymise localement contrats, notes et avis avant tout envoi à ChatGPT ou Claude, puis réidentifie la réponse. Les juristes gardent les outils qu'ils aiment, et aucune donnée sensible ne sort de l'entreprise (déploiement sur site possible).
>
> Seriez-vous disponible 20 minutes pour en parler ?
>
> Mariia Zameshina, Hexagone AI

**J3 · LinkedIn** : invitation sans note.

**J8 · E-mail 2 (même fil)**
> {{salutation}},
>
> Je me permets de revenir vers vous avec une question simple : vos juristes utilisent-ils déjà ChatGPT ou Claude, avec ou sans cadre ? La pseudonymisation locale permet de garder ces usages tout en protégeant le secret des affaires et les données personnelles.
>
> Un créneau de 20 minutes vous conviendrait-il ?
>
> Mariia

**J15 · E-mail 3 (même fil, dernier)** : identique au J12 du segment C.

---

## Avant d'appuyer sur « lancer »

1. **Boîte d'envoi Hexagone AI** connectée (idéalement un sous-domaine dédié, ex. `prenom@go.<domaine-hexagone>`), avec SPF, DKIM et DMARC, et réchauffée au moins 2 à 3 semaines. Plusieurs domaines visés rejettent tout e-mail mal authentifié (DMARC `p=reject` : SFEIR, BNP, BPCE).
2. **29 adresses génériques** (contact@…) : la ligne `{{ligne_attention}}` est remplie pour elles ; elle est vide pour les adresses nominatives (supprimer la ligne vide à l'affichage si l'outil le permet).
4. **Mention de désinscription** en pied de chaque e-mail (prospection B2B, RGPD) : « Si vous ne souhaitez plus recevoir de messages de ma part, répondez simplement "stop". »
5. Tester l'aperçu de 5 contacts par segment avant le lancement (variables bien remplies).
