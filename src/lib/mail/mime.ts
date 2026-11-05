// Construction du message RFC 5322 envoyé à Gmail. Pur et testable.
import { randomBytes } from "node:crypto";
import { isEmail } from "./types";

export type MimeInput = {
  from: { email: string; name?: string | null };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: { name: string; mimeType: string; data: Buffer }[];
};

// Un retour à la ligne dans une valeur permettrait d'injecter des en-têtes (destinataires cachés, etc.)
function headerSafe(v: string, label: string) {
  if (/[\r\n\0]/.test(v)) throw new Error(`Caractère interdit dans ${label}`);
  return v;
}

function encodeWord(v: string) {
  if (/^[\x20-\x7e]*$/.test(v) && v.length <= 900) return v;
  // découpé par caractères : un encodage ne coupe jamais un caractère en deux
  const out: string[] = [];
  let cur = "";
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch) > 45) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((p) => `=?UTF-8?B?${Buffer.from(p).toString("base64")}?=`).join("\r\n ");
}

function address(list: string[], label: string) {
  for (const a of list) {
    headerSafe(a, label);
    if (!isEmail(a)) throw new Error(`Adresse invalide : ${a}`);
  }
  return list.join(", ");
}

const wrap = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
const b64 = (v: string | Buffer) => wrap(Buffer.from(v).toString("base64"));

function attachmentName(name: string) {
  const clean = headerSafe(name, "le nom de fichier").replace(/["\\/]/g, "_");
  return `filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function buildMime(m: MimeInput): Buffer {
  const boundary = (p: string) => `=_cely_${p}_${randomBytes(12).toString("hex")}`;
  if (!m.to.length) throw new Error("Indiquez au moins un destinataire.");
  const fromName = m.from.name ? headerSafe(m.from.name, "le nom d'expéditeur").replace(/["\\]/g, "") : "";
  const headers = [
    `From: ${fromName ? `${/^[\x20-\x7e]*$/.test(fromName) ? `"${fromName}"` : encodeWord(fromName)} ` : ""}<${address([m.from.email], "l'expéditeur")}>`,
    `To: ${address(m.to, "le destinataire")}`,
    m.cc?.length ? `Cc: ${address(m.cc, "la copie")}` : "",
    m.bcc?.length ? `Bcc: ${address(m.bcc, "la copie cachée")}` : "",
    `Subject: ${encodeWord(headerSafe(m.subject, "l'objet"))}`,
    m.inReplyTo ? `In-Reply-To: ${headerSafe(m.inReplyTo, "la référence")}` : "",
    m.references ? `References: ${headerSafe(m.references, "la référence")}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const textPart = [`Content-Type: text/plain; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", b64(m.text)].join("\r\n");
  let body: string;
  if (m.html) {
    const alt = boundary("alt");
    const htmlPart = [`Content-Type: text/html; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", b64(m.html)].join("\r\n");
    body = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`].join("\r\n");
  } else body = textPart;

  if (m.attachments?.length) {
    const mixed = boundary("mix");
    const parts = m.attachments.map((a) => {
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType)) throw new Error("Type de pièce jointe invalide");
      return [`Content-Type: ${a.mimeType}`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; ${attachmentName(a.name)}`, "", b64(a.data)].join("\r\n");
    });
    body = [`Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, body, ...parts.flatMap((p) => [`--${mixed}`, p]), `--${mixed}--`].join("\r\n");
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n${body}\r\n`);
}
