// Types partagés navigateur / serveur pour la boîte Gmail. Aucun jeton ne transite par ces types.
export type BoxStatus = {
  /** none : pas de compte ; pending : jamais lancée ; initial : première lecture en cours ; ready : à jour ; error : à traiter */
  state: "none" | "pending" | "initial" | "ready" | "error";
  email: string | null;
  message: string;
  messages: number;
  last_sync_at: string | null;
  started_at: string | null;
  /** le compte a accordé la gestion de la boîte (tri, brouillons) ; sinon lecture seule jusqu'à la reconnexion */
  can_modify: boolean;
};

export const BOX_ACTIONS = ["archive", "trash", "untrash", "read", "unread", "star", "unstar", "important", "unimportant", "spam", "unspam", "label", "unlabel", "move"] as const;
export type BoxAction = (typeof BOX_ACTIONS)[number];
/** done : fils modifiés dans Gmail ; failed : fils qui n'existent plus dans Gmail */
export type BoxActionResult = { done: string[]; failed: string[] };

export type BoxFolder = { id: string; name: string; kind: "system" | "user"; unread: number; total: number };

export type BoxThread = {
  thread_id: string;
  last_at: string;
  subject: string;
  snippet: string;
  participants: string[];
  message_count: number;
  label_ids: string[];
  unread: boolean;
  starred: boolean;
  important: boolean;
  has_attachments: boolean;
};

export type BoxThreadPage = { threads: BoxThread[]; next: string | null };

export type BoxOpenMessage = {
  id: string;
  from_name: string | null;
  from_email: string | null;
  to: string;
  cc: string;
  at: string;
  /** pour répondre et transférer : objet, identifiants de fil, adresses */
  subject: string;
  rfc_message_id: string | null;
  references: string | null;
  reply_to: string[];
  to_list: string[];
  cc_list: string[];
  label_ids: string[];
  /** HTML nettoyé côté serveur, affiché dans un cadre isolé sans script. */
  html: string;
  /** le message contient des images distantes, masquées tant que l'utilisateur ne les demande pas */
  remote_images: boolean;
  /** désignées par leur position dans le message (les identifiants Gmail changent à chaque lecture) */
  attachments: { name: string; mime_type: string; size: number }[];
};
export type BoxOpenThread = { thread_id: string; subject: string; messages: BoxOpenMessage[] };

/** Dossiers proposés, dans l'ordre d'affichage ; « ALL » n'est pas un libellé Gmail (tout sauf Spam et Corbeille). */
export const SYSTEM_FOLDERS: { id: string; label: string }[] = [
  { id: "INBOX", label: "Boîte de réception" },
  { id: "STARRED", label: "Suivis" },
  { id: "IMPORTANT", label: "Importants" },
  { id: "SENT", label: "Envoyés" },
  { id: "DRAFT", label: "Brouillons" },
  { id: "ALL", label: "Tous les messages" },
  { id: "SPAM", label: "Spam" },
  { id: "TRASH", label: "Corbeille" },
];
export const CATEGORY_FOLDERS: { id: string; label: string }[] = [
  { id: "CATEGORY_PERSONAL", label: "Principale" },
  { id: "CATEGORY_SOCIAL", label: "Réseaux sociaux" },
  { id: "CATEGORY_PROMOTIONS", label: "Promotions" },
  { id: "CATEGORY_UPDATES", label: "Notifications" },
  { id: "CATEGORY_FORUMS", label: "Forums" },
];

/** Le fil apparaît-il dans ce dossier ? « ALL » : tout sauf Spam et Corbeille. */
export const inFolder = (labels: string[], folder: string) => (folder === "ALL" ? !labels.includes("SPAM") && !labels.includes("TRASH") : labels.includes(folder));

/**
 * Libellés d'un fil après une action, pour mettre l'écran à jour sans attendre Gmail. Estimation au niveau du fil :
 * l'état exact, message par message, vient de la réponse de Gmail puis de la synchronisation.
 */
export function applyBoxAction(labels: string[], action: BoxAction, extra: { label_id?: string; from_label?: string } = {}): string[] {
  const set = new Set(labels);
  const add = (...l: (string | undefined)[]) => l.forEach((x) => x && set.add(x));
  const del = (...l: (string | undefined)[]) => l.forEach((x) => x && set.delete(x));
  switch (action) {
    case "archive": del("INBOX"); break;
    case "trash": return [...labels.filter((l) => l !== "INBOX" && l !== "SPAM" && l !== "TRASH"), "TRASH"];
    case "untrash": del("TRASH"); add("INBOX"); break;
    case "read": del("UNREAD"); break;
    case "unread": add("UNREAD"); break;
    case "star": add("STARRED"); break;
    case "unstar": del("STARRED"); break;
    case "important": add("IMPORTANT"); break;
    case "unimportant": del("IMPORTANT"); break;
    case "spam": return [...labels.filter((l) => l !== "INBOX" && l !== "TRASH" && l !== "SPAM"), "SPAM"];
    case "unspam": del("SPAM"); add("INBOX"); break;
    case "label": add(extra.label_id); break;
    case "unlabel": del(extra.label_id); break;
    case "move":
      del("TRASH", "SPAM");
      if (extra.from_label && extra.from_label !== "ALL" && extra.from_label !== extra.label_id) del(extra.from_label);
      else if (extra.label_id !== "INBOX") del("INBOX");
      add(extra.label_id);
      break;
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Rédaction (lot M04)
// ---------------------------------------------------------------------------
/** Pièce jointe déjà dans Gmail : désignée par son message et sa position (brouillon en cours ou message transféré). */
export type AttachmentRef = { message_id: string; n: number; name: string; size: number };
export type ComposeContext = { email: string; name: string | null; signature_html: string; can_compose: boolean };
export type ComposeDraft = {
  draft_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  attachments: AttachmentRef[];
};
export type ComposeSaved = { draft_id: string; message_id: string; thread_id: string | null; attachments: AttachmentRef[] };
/** Fichiers ajoutés depuis l'ordinateur : limite par enregistrement (taille d'une requête vers le serveur). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "4 Mo";
