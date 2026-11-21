// Types partagés navigateur / serveur pour la boîte Gmail. Aucun jeton ne transite par ces types.
export type BoxStatus = {
  /** none : pas de compte ; pending : jamais lancée ; initial : première lecture en cours ; ready : à jour ; error : à traiter */
  state: "none" | "pending" | "initial" | "ready" | "error";
  email: string | null;
  message: string;
  messages: number;
  last_sync_at: string | null;
  started_at: string | null;
};

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
