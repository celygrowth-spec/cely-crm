// Contenu de l'onboarding de l'offre découverte : tout ce qui se lit, rassemblé ici pour être modifié sans toucher
// à la logique. Ajouter, retirer ou réordonner une question : modifier OFFER_QUESTIONS (la clé `key` est l'identifiant
// enregistré en base ; ne pas la changer pour une question qui a déjà des réponses).
//
// Captures d'écran des tutos : déposer les images dans public/onboarding/ et renseigner `image` sur l'étape
// (ex. "/onboarding/lemlist-1-connexion.png"). Sans `image`, un emplacement réservé affiche la légende `capture`
// (la capture exacte à faire). `review: true` = étape à relire (non vérifiée dans la documentation officielle).

export const OWNER_FIRST_NAME = "Célien";

export const OFFER = {
  name: "Offre découverte",
  price: "500 €",
  contacts: 300,
  targets: 3,
  channels: "email + LinkedIn",
  days: 28,
  estimatedMinutes: 10,
} as const;

export type StepKey = "welcome" | "offer" | "lemlist" | "blacklist" | "linkedin" | "documents" | "targets" | "recap";

export const STEPS: { key: StepKey; title: string; short: string; optional?: boolean }[] = [
  { key: "welcome", title: "Bienvenue", short: "Bienvenue" },
  { key: "offer", title: "Quelques questions sur ton offre", short: "Ton offre" },
  { key: "lemlist", title: "lemlist", short: "lemlist" },
  { key: "blacklist", title: "Ta blacklist", short: "Blacklist" },
  { key: "linkedin", title: "Tes archives LinkedIn", short: "LinkedIn" },
  { key: "documents", title: "Autres documents", short: "Documents", optional: true },
  { key: "targets", title: "Tes 3 cibles", short: "Cibles" },
  { key: "recap", title: "Récapitulatif", short: "Récap" },
];

export type Question = { key: string; title: string; help: string; placeholder: string; example?: string; optional?: boolean; multiline?: boolean };

/** Case proposée sous chaque question : cochée, le client passe à la suite et la question ressort dans mon panneau. */
export const UNKNOWN = {
  label: "Je ne sais pas",
  hint: "Pas de souci : on complétera ensemble.",
  /** Libellé côté CRM (panneau de suivi, connecteur Claude). */
  crm: "À compléter avec le client",
  needed: "Écris ta réponse, ou coche « Je ne sais pas » pour passer à la suite.",
} as const;

/** Champ facultatif affiché sous la question 4 (clé `recent_clients`). Le lien arrive sur la fiche entreprise. */
export const WEBSITE_FIELD = {
  question: "recent_clients",
  label: "Lien de votre site (si vous en avez un)",
  placeholder: "https://www.exemple.fr",
} as const;

/** Étape 1. Ces réponses servent à écrire des messages personnalisés : ton, preuves, angle, interdits. */
export const OFFER_QUESTIONS: Question[] = [
  {
    key: "offer_pitch",
    title: "Ton offre, en une phrase ?",
    help: "Comme si tu la présentais à un prospect en 10 secondes. Pas besoin que ce soit parfait.",
    placeholder: "On aide les … à … grâce à …",
    example: "On aide les PME industrielles à réduire leurs arrêts machine grâce à la maintenance prédictive.",
  },
  {
    key: "problem",
    title: "Quel problème résous-tu pour tes clients ?",
    help: "Le problème tel qu'ils le décrivent eux-mêmes, avec leurs mots. C'est ce qui accroche dans un premier message.",
    placeholder: "Avant de travailler avec nous, ils…",
    multiline: true,
  },
  {
    key: "results",
    title: "Quel résultat concret obtiennent-ils ?",
    help: "Un chiffre, un délai, un avant / après. Une preuve vaut mieux que trois adjectifs.",
    placeholder: "Ex. : −30 % de temps passé sur…, en 3 mois",
    multiline: true,
  },
  {
    key: "recent_clients",
    title: "Deux ou trois clients récents typiques ?",
    help: "Qui ils sont (secteur, taille, poste de ton interlocuteur) et pourquoi ils t'ont choisi. Les noms restent entre nous si tu préfères.",
    placeholder: "Ex. : DAF d'une ETI de 300 personnes dans l'agroalimentaire, venu pour…",
    multiline: true,
  },
  {
    key: "competitors",
    title: "Tes concurrents, et ce qui te distingue ?",
    help: "Les noms qui reviennent quand un prospect compare, ou ce qu'il fait à la place (Excel, un stagiaire, rien…).",
    placeholder: "Ex. : X et Y ; nous, on…",
    multiline: true,
  },
  {
    key: "objections",
    title: "L'objection que tu entends le plus ?",
    help: "Et ce que tu réponds d'habitude. On l'anticipe dans les relances.",
    placeholder: "« C'est trop cher » → …",
    multiline: true,
    optional: true,
  },
  {
    key: "never_say",
    title: "Ce qu'il ne faut jamais dire ?",
    help: "Mots, promesses, ton, sujets sensibles, clients à ne pas citer. On s'y tient à la lettre.",
    placeholder: "Ex. : ne jamais promettre de délai, pas de tutoiement, ne pas citer le client Z…",
    multiline: true,
  },
];

/**
 * Étape d'un tuto. `image` : capture affichée (fichier dans public/onboarding/). `capture` : légende exacte de la
 * capture attendue ; sans `image`, c'est elle qui s'affiche dans l'emplacement réservé. `source` : d'où vient le visuel.
 */
export type TutoStep = { title: string; body: string; image?: string; capture: string; source?: string; review?: boolean };

/**
 * Étape 2 — lemlist. Procédure et captures vérifiées le 22/11/2026 dans le centre d'aide officiel de lemlist :
 *  - « Manage agency roles and permissions » (help.lemlist.com/en/articles/8548092) : profil en bas à gauche ›
 *    Settings › Team settings › Billing & Users › onglet Users › Invite user › email › « Add as paying user » ou
 *    « Add as free user » › Invite. Captures des étapes 2, 3 et 4.
 *  - « Manage team members (add or remove) » (help.lemlist.com/en/articles/4452805) : un utilisateur payant occupe
 *    une place de l'abonnement ; un utilisateur gratuit accède à lemlist mais ne peut pas envoyer de campagnes.
 *  - « Use SSO in lemlist (Google/Microsoft)… » (help.lemlist.com/en/articles/13285392) : inscription avec Google,
 *    Microsoft ou email et mot de passe. Capture de l'étape 1.
 * Les libellés entre guillemets sont ceux de l'interface lemlist (en anglais).
 */
export const LEMLIST_TUTO: TutoStep[] = [
  {
    title: "Crée ton compte lemlist",
    body: "Ouvre app.lemlist.com et clique sur « Create account for free ». Inscris-toi avec ton adresse professionnelle : « Google », « Microsoft », ou email et mot de passe. Tu as déjà un compte ? Connecte-toi simplement.",
    image: "/onboarding/lemlist-1-connexion.png",
    capture: "Page de connexion de lemlist, avec les boutons « Google » et « Microsoft » et le lien « Create account for free »",
    source: "https://help.lemlist.com/en/articles/13285392-use-sso-in-lemlist-google-microsoft-and-switch-back-to-password-login",
  },
  {
    title: "Ouvre les réglages",
    body: "Une fois connecté, clique sur ton nom, tout en bas à gauche de l'écran, puis sur « Settings ».",
    image: "/onboarding/lemlist-2-settings.png",
    capture: "Menu du profil ouvert en bas à gauche de lemlist, entrée « Settings » encadrée",
    source: "https://help.lemlist.com/en/articles/8548092-manage-agency-roles-and-permissions",
  },
  {
    title: "Va dans « Billing & Users », onglet « Users »",
    body: "Dans la colonne de gauche, sous « Team settings », clique sur « Billing & Users ». Ouvre l'onglet « Users » en haut, puis clique sur le bouton « Invite user » à droite.",
    image: "/onboarding/lemlist-3-users.png",
    capture: "Réglages lemlist : « Billing & Users » dans la colonne de gauche, onglet « Users » et bouton « Invite user » encadrés",
    source: "https://help.lemlist.com/en/articles/8548092-manage-agency-roles-and-permissions",
  },
  {
    title: "Invite-moi",
    body: "Dans la fenêtre « Invite co-workers to your team », colle l'adresse ci-dessous dans « Email », puis choisis « Add as paying user » : c'est ce qui me permet de lancer les campagnes (une place de ton abonnement lemlist). Avec « Add as free user », je vois ton espace mais je ne peux rien envoyer. Termine avec « Invite ». Un doute sur l'abonnement ? Choisis « free user », on ajuste ensemble.",
    image: "/onboarding/lemlist-4-invitation.png",
    capture: "Fenêtre « Invite co-workers to your team » : champ « Email », choix « Add as paying user » / « Add as free user », bouton « Invite »",
    source: "https://help.lemlist.com/en/articles/8548092-manage-agency-roles-and-permissions",
  },
];
export const LEMLIST_URL = "https://app.lemlist.com";
/** Adresse à inviter dans lemlist, affichée tant que le réglage du panneau de suivi est vide (le réglage l'emporte). */
export const LEMLIST_INVITE_DEFAULT = "celygrowth@gmail.com";

/**
 * Étape 4 — archive LinkedIn. Vérifié le 18/11/2026 dans l'aide LinkedIn « Download your account data »
 * (linkedin.com/help/linkedin/answer/a1339364) : Vous › Préférences et confidentialité › Confidentialité des données ›
 * Télécharger vos données ; archive volumineuse envoyée sous 24 h ; lien valable 72 h ; ordinateur uniquement.
 * Les libellés français exacts des menus sont à relire.
 */
export const LINKEDIN_TUTO: TutoStep[] = [
  {
    title: "Sur ordinateur, ouvre la page « Télécharger vos données »",
    body: "Le plus simple : le bouton ci-dessous. Sinon : ta photo « Vous » en haut de LinkedIn › « Préférences et confidentialité » › « Confidentialité des données » › « Télécharger vos données ». Pas possible depuis l'application mobile.",
    capture: "LinkedIn sur ordinateur : menu « Vous » › « Préférences et confidentialité » › « Confidentialité des données » › « Télécharger vos données »",
    review: true,
  },
  {
    title: "Choisis l'archive complète",
    body: "Sélectionne la première option, le téléchargement le plus volumineux (connexions, messages et le reste), puis « Demander l'archive ». LinkedIn peut te redemander ton mot de passe.",
    capture: "Page LinkedIn « Télécharger vos données » : première option (archive complète) sélectionnée et bouton « Demander l'archive »",
    review: true,
  },
  {
    title: "Attends l'email de LinkedIn (jusqu'à 24 h)",
    body: "L'archive complète arrive par email, souvent plus vite, mais LinkedIn annonce jusqu'à 24 h. Le lien de téléchargement n'est valable que 72 h : télécharge-la dès réception.",
    capture: "Email de LinkedIn annonçant que l'archive est prête, avec le lien de téléchargement",
  },
  {
    title: "Dépose le fichier ZIP ici",
    body: "Ne le décompresse pas : dépose le .zip tel quel. Si plusieurs personnes de ton équipe prospectent, ajoute une archive par compte.",
    capture: "Fichier ZIP de l'archive LinkedIn dans le dossier Téléchargements, non décompressé",
  },
];
export const LINKEDIN_EXPORT_URL = "https://www.linkedin.com/psettings/data-privacy/";

export const BLACKLIST_HELP = {
  why: "Ta blacklist, c'est la liste des personnes et entreprises que je ne dois jamais contacter : tes clients actuels, les prospects avec qui tu es déjà en discussion, tes partenaires, et tous ceux qui ont demandé à ne pas être sollicités.",
  format: "Un fichier CSV ou Excel. Idéalement une ligne par contact ou par entreprise, avec au moins l'email, le domaine du site ou le nom de l'entreprise. Pas besoin de le mettre en forme : je m'en occupe.",
};

export const DOCUMENTS_HELP = "Présentation commerciale, études de cas, témoignages, plaquette, grille tarifaire publique… tout ce qui m'aide à parler de ton offre comme toi. Étape facultative.";

export const TARGET_FIELDS: { key: "name" | "sector" | "company_size" | "roles" | "geography" | "notes"; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: "name", label: "Nom de la cible", placeholder: "Ex. : DAF d'ETI industrielles" },
  { key: "sector", label: "Secteur", placeholder: "Ex. : industrie, agroalimentaire" },
  { key: "company_size", label: "Taille d'entreprise", placeholder: "Ex. : 50 à 500 salariés" },
  { key: "roles", label: "Postes visés", placeholder: "Ex. : DAF, contrôleur de gestion" },
  { key: "geography", label: "Zone géographique", placeholder: "Ex. : France, Belgique" },
  { key: "notes", label: "Notes", placeholder: "Précisions, exclusions…", multiline: true },
];

/** Ce que dit la mascotte. {prénom} est remplacé par le prénom du contact. */
export const MASCOT_LINES = {
  welcome: "Salut {prénom} ! Je suis Cely. En une dizaine de minutes, on prépare tout ce qu'il faut pour lancer ton test.",
  welcomeKit: ["Ton offre en tête (7 questions rapides, dont une facultative)", "Un accès à ton email pro pour créer un compte lemlist", "Ta liste de clients et prospects à exclure (CSV ou Excel), si tu en as une", "Ton accès LinkedIn pour demander ton archive"],
  stepDone: ["Parfait !", "Et de un de plus !", "Super, c'est noté.", "On avance bien !", "Top, merci !"],
  offerAnswered: ["Noté !", "J'adore.", "Très clair.", "Ça va m'aider.", "Bien vu."],
  later: "Pas de souci : l'étape reste ouverte, tu pourras revenir quand LinkedIn t'aura envoyé l'archive.",
  none: "Pas de souci, on passe à la suite.",
  unknown: "Pas de souci, on verra ça ensemble.",
  conflict: "Oups, quelqu'un de ton équipe vient de modifier cette réponse. Choisis la version à garder.",
  recap: "Dernière ligne droite : relis, corrige si besoin, et envoie !",
  sent: "C'est envoyé ! Je m'occupe du reste.",
  offline: "La connexion a sauté : je réessaie tout seul, rien n'est perdu.",
};

/** Le déroulé des 28 jours, montré à l'accueil et après l'envoi. */
export const TIMELINE = [
  { when: "Jours 1 à 5", what: "Je construis tes 3 listes (300 contacts) et j'écris les messages, que tu valides." },
  { when: "Jours 6 à 21", what: "Les campagnes email + LinkedIn tournent. Tu reçois les réponses au fil de l'eau." },
  { when: "Jours 22 à 28", what: "On fait le bilan ensemble : ce qui marche, par cible, et la suite." },
];

export const AFTER_SEND = [
  `Je relis tout dans les 48 h ouvrées et je te dis s'il manque quelque chose.`,
  "Tu reçois les premiers messages à valider.",
  "Tu peux revenir ici à tout moment pour corriger une réponse ou ajouter ton archive LinkedIn : je verrai ce qui a changé.",
];
