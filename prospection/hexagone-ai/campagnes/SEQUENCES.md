# Hexagone AI — 5 campagnes (lancement 13/11/2026)

Expéditrice : **Mariia Zameshina, cofondatrice d'Hexagone AI**. Un fichier CSV par campagne dans ce dossier.
Variables : `{{salutation}}` (« Maître Nom » ou « Bonjour Prénom »), `{{ligne_attention}}` (rempli seulement pour les adresses génériques), `{{accroche}}` (phrase personnalisée et sourcée de chaque prospect), `{{companyName}}`, `{{firstName}}`.
Colonne `a_verifier = oui` : prospect dont le poste ou l'adresse reste à confirmer — à relire (ou retirer) avant l'envoi.
Pied de chaque e-mail : « Si vous ne souhaitez plus recevoir de messages de ma part, répondez simplement "stop". »

| Campagne | Fichier | Prospects | Étapes |
|---|---|---|---|
| 1 · Avocats | C1_avocats.csv | 197 | J0 e-mail · J2 invitation LinkedIn · J5 relance · J12 clôture |
| 2 · Experts-comptables | C2_experts_comptables.csv | 58 | J0 e-mail · J2 invitation LinkedIn · J5 relance · J12 clôture |
| 3 · Partenaires Anthropic | C3_partenaires_anthropic.csv | 42 | J0 e-mail · J2 invitation LinkedIn · J6 relance · J13 clôture |
| 4 · Directions juridiques | C4_directions_juridiques.csv | 74 | J0 e-mail · J3 invitation LinkedIn · J8 relance · J15 clôture |
| 5 · LinkedIn uniquement | C5_linkedin_uniquement.csv | 24 | J0 visite + invitation · J1 message (si accepté) · J6 relance |

---

## Campagne 1 · Avocats

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

**J2 · LinkedIn** : invitation sans note.

**J5 · E-mail 2 (même fil)**
> {{salutation}},
>
> Je me permets de revenir vers vous avec un élément concret : le guide du CNB « La déontologie et l'intelligence artificielle » (mars 2026) et la charte IA du Barreau de Paris (juillet 2026) rappellent qu'aucune donnée couverte par le secret ne doit être transmise à un outil d'IA sans garanties. La pseudonymisation locale permet justement de garder ces outils, sans transférer l'identité des clients.
>
> Un créneau de 20 minutes vous conviendrait-il cette semaine ou la suivante ?
>
> Mariia

**J12 · E-mail 3 (même fil, dernier)**
> {{salutation}},
>
> Je ne voudrais pas encombrer votre boîte : je clos ce fil. Si la question de l'IA et du secret professionnel revient chez {{companyName}}, il suffit de répondre à ce message et je vous montre l'outil en 20 minutes.
>
> Bonne continuation,
> Mariia

---

## Campagne 2 · Experts-comptables

**J0 · E-mail 1**
Objet : `{{companyName}} : l'IA sur les dossiers clients, sans les exposer`

> {{ligne_attention}}
>
> {{salutation}},
>
> {{accroche}}
>
> Hexagone AI pseudonymise les documents (balances, liasses, bulletins, contrats) sur votre poste avant tout envoi à ChatGPT, Claude ou Copilot, puis remet les vrais noms dans la réponse : l'IA ne voit jamais l'identité de vos clients. Déploiement possible sur vos propres serveurs.
>
> 20 minutes pour vous le montrer sur un document de votre choix ?
>
> Mariia Zameshina
> Cofondatrice, Hexagone AI — HEC Incubator, Station F

**J2 · LinkedIn** : invitation sans note.

**J5 · E-mail 2 (même fil)**
> {{salutation}},
>
> Je reviens vers vous avec un point simple : le secret professionnel de l'expert-comptable et le RGPD s'appliquent aussi aux données envoyées à un outil d'IA. La pseudonymisation locale permet à vos collaborateurs de garder ces outils sans faire sortir les données de vos clients.
>
> Un créneau de 20 minutes vous conviendrait-il ?
>
> Mariia

**J12 · E-mail 3 (dernier)** : identique au J12 de la campagne 1 (remplacer « secret professionnel » par « confidentialité des données clients »).

---

## Campagne 3 · Partenaires Anthropic (angle partenariat)

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

**J13 · E-mail 3 (dernier)**
> {{salutation}},
>
> Je clos ce fil ; si un projet Claude bute sur la confidentialité chez un de vos clients, je reste disponible pour en parler.
>
> Mariia

---

## Campagne 4 · Directions juridiques

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

**J15 · E-mail 3 (dernier)** : identique au J12 de la campagne 1 (remplacer « secret professionnel » par « confidentialité »).

---

## Campagne 5 · LinkedIn uniquement (pas d'e-mail trouvé)

**J0 · Visite du profil + invitation** (note ≤ 300 caractères)
> Bonjour {{firstName}}, je suis cofondatrice d'Hexagone AI : nous permettons d'utiliser ChatGPT ou Claude sur des dossiers confidentiels sans que les données ne quittent la structure. Ravie d'échanger avec vous.

**J1 · Message (si l'invitation est acceptée)**
> Merci pour la connexion, {{firstName}}. {{accroche}} Seriez-vous partant(e) pour 20 minutes de démonstration, sur un document de votre choix ?

**J6 · Relance**
> {{firstName}}, je me permets de relancer : si le sujet de l'IA et de la confidentialité est d'actualité chez {{companyName}}, je vous montre l'outil en 20 minutes. Sinon, aucun souci.
