import "server-only";
// Secrets du module Rendez-vous, tous dérivés de APPOINTMENTS_SECRET (jamais envoyé au navigateur) :
// - clé serveur : autorise les fonctions publiques en base (seule son empreinte y est stockée) ;
// - jeton privé d'un rendez-vous : HMAC de son identifiant (liens d'annulation et de report) ;
// - clé de chiffrement AES-256-GCM du jeton Google.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appointmentsSecretOrNull } from "./config";

export class AppointmentsNotConfigured extends Error {
  constructor() {
    super("Réservation non configurée : la variable APPOINTMENTS_SECRET est absente (voir docs/integrations/google-calendar.md).");
  }
}

function secret(): string {
  const s = appointmentsSecretOrNull();
  if (!s) throw new AppointmentsNotConfigured();
  return s;
}

const derive = (label: string) => createHmac("sha256", secret()).update(`cely-appointments:${label}`).digest();
const b64u = (b: Buffer) => b.toString("base64url");

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Clé transmise aux fonctions publiques de la base. */
export function serverRpcKey(): string {
  return b64u(derive("rpc"));
}

export function serverRpcKeyHash(): string {
  return sha256Hex(serverRpcKey());
}

/** Jeton privé d'un rendez-vous (déterministe : un double clic retrouve le même lien). */
export function manageToken(bookingId: string): string {
  return b64u(createHmac("sha256", derive("manage")).update(bookingId).digest());
}

/** Lien privé : « <id>.<jeton> ». */
export function manageRef(bookingId: string): string {
  return `${bookingId}.${manageToken(bookingId)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Vérifie un lien privé ; renvoie l'identifiant et l'empreinte du jeton, ou null. */
export function parseManageRef(ref: string): { id: string; tokenHash: string } | null {
  const [id, token] = decodeURIComponent(ref).split(".");
  if (!id || !token || !UUID_RE.test(id) || token.length > 100) return null;
  const expected = Buffer.from(manageToken(id));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id, tokenHash: sha256Hex(token) };
}

export function tokenHashFor(bookingId: string): string {
  return sha256Hex(manageToken(bookingId));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive("enc"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join(".");
}

export function decryptSecret(value: string): string {
  const [v, iv, tag, ct] = value.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Format chiffré inconnu");
  const d = createDecipheriv("aes-256-gcm", derive("enc"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
