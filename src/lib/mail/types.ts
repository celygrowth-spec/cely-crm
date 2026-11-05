// Types et libellés partagés navigateur / serveur. Aucun jeton ne transite par ces types.
export type MailStatus = "draft" | "pending" | "sending" | "accepted" | "failed" | "uncertain" | "cancelled";
export type MailOrigin = "manual" | "prospection" | "appointment" | "system";

export const MAIL_STATUS_LABELS: Record<MailStatus, string> = {
  draft: "Brouillon",
  pending: "En attente",
  sending: "En cours",
  accepted: "Accepté par Gmail", // ni « livré » ni « lu » : Gmail ne l'indique pas
  failed: "Échec",
  uncertain: "Résultat incertain",
  cancelled: "Annulé",
};

export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

export type MailAttachment = { id: string; file_id: string | null; name: string; mime_type: string; size_bytes: number };

export type MailMessage = {
  id: string;
  account_id: string | null;
  status: MailStatus;
  origin: MailOrigin;
  company_id: string | null;
  person_id: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  bcc_addrs: string[];
  subject: string;
  body_text: string;
  signature: string;
  in_reply_to: string | null;
  references_hdr: string | null;
  provider_thread_id: string | null;
  provider_message_id: string | null;
  business_type: string | null;
  business_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  attachments: MailAttachment[];
};

export type MailAccount = {
  id: string;
  provider: "gmail";
  email: string;
  display_name: string | null;
  status: "connected" | "needs_reconnect" | "disconnected";
  is_default: boolean;
  scopes: string[];
  signature: string;
  last_error: string | null;
  connected_at: string;
  disconnected_at: string | null;
};

/** Texte réellement envoyé : le corps, puis la signature selon l'usage (« -- »). */
export function withSignature(body: string, signature: string) {
  const s = signature.trim();
  return s ? `${body.trimEnd()}\n\n-- \n${s}` : body;
}

const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\.]{2,}$/;
export const isEmail = (v: string) => v.length <= 320 && EMAIL.test(v);

/** « a@b.fr, c@d.fr ; e@f.fr » → liste. */
export const splitAddresses = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
