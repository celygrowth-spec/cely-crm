import { createHmac, timingSafeEqual } from "node:crypto";

// Signature des webhooks Fireflies V2 : « sha256= » + HMAC-SHA256 (hexa) du corps brut, clé = secret de signature.
export function signPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signPayload(rawBody, secret));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
