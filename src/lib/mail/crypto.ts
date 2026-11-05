import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Chiffrement des jetons Google avant stockage (AES-256-GCM). La clé reste dans l'environnement serveur :
// une lecture de la base, même autorisée, ne donne aucun jeton utilisable.
function key(raw: string) {
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("MAIL_TOKEN_KEY doit faire 32 octets en base64 (openssl rand -base64 32)");
  return k;
}

export function encryptSecret(plain: string, rawKey: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptSecret(blob: string, rawKey: string) {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Jeton chiffré illisible");
  const d = createDecipheriv("aes-256-gcm", key(rawKey), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
