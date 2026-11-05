import "server-only";
// Accès au portail client : codes, empreintes et cookie de session.
// - Code : 20 caractères aléatoires (alphabet Crockford, 100 bits), affiché une seule fois à l'administrateur.
//   La base ne reçoit que son HMAC (clé dérivée de APPOINTMENTS_SECRET) : une fuite de la base ne révèle rien.
// - Session : jeton aléatoire de 256 bits dans un cookie httpOnly ; la base n'en garde que l'empreinte.
// - Aucun secret dans l'URL ni dans le stockage du navigateur.
import { createHash, randomBytes } from "node:crypto";
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

/** Adresse du client (Vercel renseigne x-forwarded-for ; seule son empreinte est conservée). */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "";
}
