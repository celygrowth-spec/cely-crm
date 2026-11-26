import "server-only";
// Accès au portail client : codes, empreintes et cookie de session.
// - Code : 20 caractères aléatoires (alphabet Crockford, 100 bits), affiché une seule fois à l'administrateur.
//   La base ne reçoit que son HMAC (clé dérivée de APPOINTMENTS_SECRET) : une fuite de la base ne révèle rien.
// - Session : jeton aléatoire de 256 bits dans un cookie httpOnly ; la base n'en garde que l'empreinte.
// - Invitation : jeton aléatoire de 256 bits, transmis dans le fragment du lien (#…, jamais envoyé au serveur
//   par le navigateur ni journalisé) ; la base n'en garde que le HMAC.
// - Mot de passe : empreinte scrypt calculée ici ; la base ne voit jamais le mot de passe.
// - Aucun secret dans l'URL ni dans le stockage du navigateur.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { serverHmacHex } from "@/lib/appointments/secrets";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford : sans I, L, O, U

export function generateCode(): { code: string; hint: string } {
  const bytes = randomBytes(20);
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b & 31];
  const code = raw.match(/.{4}/g)!.join("-");
  return { code, hint: raw.slice(-4) };
}

/** Saisie tolérante : espaces, tirets, minuscules, O→0, I/L→1. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function codeHash(input: string): string {
  return serverHmacHex("portal-code", normalizeCode(input));
}

export function ipHash(ip: string): string {
  return serverHmacHex("portal-ip", ip || "inconnue");
}

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sessionHash(token) };
}

export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");

export const PORTAL_COOKIE = "cely_portal";
export const PORTAL_MAX_AGE = 30 * 86400;

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: PORTAL_MAX_AGE };
}

// Invitations et comptes ----------------------------------------------------------------------

export const normalizeEmail = (s: string) => s.trim().toLowerCase();

export const inviteHash = (token: string) => serverHmacHex("portal-invite", token.trim());

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: inviteHash(token) };
}

/** Empreinte de l'identifiant : limite les essais par compte sans stocker l'email dans les tentatives. */
export const emailHash = (email: string) => serverHmacHex("portal-email", normalizeEmail(email));

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptKey(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** « scrypt$N$r$p$sel$clé » (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Compare en temps constant ; un compte inconnu (`stored` absent) coûte le même calcul et échoue. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const wellFormed = parts.length === 6 && parts[0] === "scrypt" && [N, r, p].every(Number.isInteger) && N <= 1 << 17 && r <= 16 && p <= 4;
  if (!wellFormed) {
    await scryptKey(password, Buffer.alloc(16), SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
    return false;
  }
  const expected = Buffer.from(parts[5], "base64url");
  if (expected.length < 16) return false;
  const key = await scryptKey(password, Buffer.from(parts[4], "base64url"), N, r, p, expected.length);
  return timingSafeEqual(expected, key);
}

/** Adresse du client (Vercel renseigne x-forwarded-for ; seule son empreinte est conservée). */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "";
}
