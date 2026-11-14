// Types partagés (serveur et navigateur) des comptes lemlist. Aucune clé n'y figure, même chiffrée.

export type LemlistAccountStatus = "connected" | "needs_reconnect" | "disconnected";

export type LemlistAccount = {
  id: string;
  company_id: string;
  company_name: string;
  company_archived: boolean;
  team_id: string;
  team_name: string;
  status: LemlistAccountStatus;
  last_error: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  connected_at: string;
};

export type LemlistClientOption = { id: string; name: string; archived: boolean };

export type LemlistOverview = { configured: boolean; accounts: LemlistAccount[]; clients: LemlistClientOption[] };

export const LEMLIST_STATUS_LABEL: Record<LemlistAccountStatus, string> = {
  connected: "Connecté",
  needs_reconnect: "À reconnecter",
  disconnected: "Déconnecté",
};

// --- Messages (lot M2) ---
export type MessageChannel = "email" | "linkedin";

export type InboxConversation = {
  id: string;
  account_id: string;
  company_id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  channels: MessageChannel[];
  last_channel: MessageChannel | null;
  last_activity_at: string;
  last_reply_at: string | null;
  has_replies: boolean;
  unread: boolean;
};

export type InboxAccount = {
  id: string;
  company_id: string;
  company_name: string;
  team_name: string;
  status: LemlistAccountStatus;
  last_synced_at: string | null;
  last_error: string | null;
};

/** Case de la grille Messages : un client ayant un compte lemlist Connecté ou À reconnecter. */
export type InboxClient = {
  company_id: string;
  company_name: string;
  /** « needs_reconnect » dès qu'un de ses comptes est à reconnecter */
  status: "connected" | "needs_reconnect";
  /** conversations non lues (même règle que le compteur de la navigation) */
  unread: number;
  last_reply_at: string | null;
  last_activity_at: string | null;
};

/** Avec un client choisi, `conversations` et `accounts` sont limités à ce client ; `clients` est toujours la grille complète. */
export type InboxData = { conversations: InboxConversation[]; accounts: InboxAccount[]; clients: InboxClient[] };

export type SyncResult = { account_id: string; company_name: string; ok: boolean; skipped: boolean; message: string | null; count?: number };

export type ThreadMessage = {
  id: string;
  channel: MessageChannel;
  direction: "in" | "out";
  at: string;
  subject: string | null;
  text: string;
  sender_name: string | null;
  sender_email: string | null;
};

export type ThreadView = {
  id: string;
  company_name: string;
  team_name: string;
  contact_name: string | null;
  contact_email: string | null;
  channels: string[];
  ok: boolean;
  error: string | null;
  messages: ThreadMessage[];
  /** expéditeur des réponses par canal, déduit du fil par le serveur (null : réponse impossible depuis le CRM) */
  reply_from: { email: { name: string | null; email: string } | null; linkedin: { name: string | null } | null };
};

export type ReplyResult = { status: "sent" | "failed" | "uncertain"; duplicate: boolean; message: string | null };
