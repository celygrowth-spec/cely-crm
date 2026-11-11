// Réception Gmail (Q03) : lecture d'un message Gmail (format « full ») en un email reçu prêt à être rattaché.
// Pur et testable : aucune requête ici. Le rattachement (contact, fiche, campagne) est fait en base
// (mail_inbound_ingest), avec les mêmes règles pour tous les messages.

export type GmailPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] };
export type GmailMessage = { id: string; threadId?: string; historyId?: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: GmailPart };

export type InboundMessage = {
  provider_message_id: string;
  provider_thread_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  from: string | null;
  to: string[];
  subject: string;
  text: string;
  received_at: string;
  /** réponse automatique, liste de diffusion, notification : conservé « ignoré », sans effet sur les campagnes */
  automatic: boolean;
  /** métadonnées seulement : le contenu des pièces jointes n'est jamais téléchargé ni stocké */
  attachments: { name: string; mime_type: string; size: number }[];
};

const header = (p: GmailPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
const b64 = (d?: string) => (d ? Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");

/** Adresse seule, en minuscules : « Claire <claire@x.fr> » → claire@x.fr. */
export function addressOf(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/<([^>]+)>/);
  const a = (m ? m[1] : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}
const addressList = (v: string | null) => (v ? v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(addressOf).filter((x): x is string => !!x) : []);

function walk(p: GmailPart | undefined, out: GmailPart[] = []) {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

const htmlToText = (h: string) =>
  h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n").trim();

/** Retire la citation du message précédent (« Le … a écrit : » et lignes « > ») : seule la réponse compte. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^(Le |On ).{5,200}(a écrit|wrote)\s*:\s*$/.test(l.trim()) || /^-{2,}\s*(Original Message|Message d'origine)/i.test(l.trim()));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith(">"));
  return kept.join("\n").trim();
}

export function isAutomatic(m: GmailMessage, from: string | null): boolean {
  const p = m.payload;
  const auto = header(p, "Auto-Submitted");
  if (auto && auto.toLowerCase() !== "no") return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test(header(p, "Precedence") ?? "")) return true;
  if (header(p, "List-Id") || header(p, "List-Unsubscribe")) return true;
  if (header(p, "X-Autoreply") || header(p, "X-Autorespond")) return true;
  if (from && /^(no-?reply|mailer-daemon|postmaster|notifications?)@/.test(from)) return true;
  if ((m.labelIds ?? []).some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l))) return true;
  return false;
}

export function parseGmailMessage(m: GmailMessage): InboundMessage {
  const p = m.payload;
  const parts = walk(p);
  const plain = parts.find((x) => x.mimeType === "text/plain" && !x.filename && x.body?.data);
  const html = parts.find((x) => x.mimeType === "text/html" && !x.filename && x.body?.data);
  const raw = plain ? b64(plain.body?.data) : html ? htmlToText(b64(html.body?.data)) : (m.snippet ?? "");
  const from = addressOf(header(p, "From"));
  return {
    provider_message_id: m.id,
    provider_thread_id: m.threadId ?? null,
    rfc_message_id: header(p, "Message-ID") ?? header(p, "Message-Id"),
    in_reply_to: header(p, "In-Reply-To"),
    references: header(p, "References"),
    from,
    to: [...addressList(header(p, "To")), ...addressList(header(p, "Cc"))],
    subject: (header(p, "Subject") ?? "").slice(0, 500),
    text: stripQuoted(raw).slice(0, 20000),
    received_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    automatic: isAutomatic(m, from),
    attachments: parts.filter((x) => x.filename).map((x) => ({ name: x.filename!.slice(0, 200), mime_type: x.mimeType ?? "application/octet-stream", size: x.body?.size ?? 0 })),
  };
}
