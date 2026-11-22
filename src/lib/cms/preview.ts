import "server-only";
// Aperçu d'un brouillon sur le site : jeton aléatoire de 256 bits, seule son empreinte (SHA-256) est en base,
// valable 24 h au plus. Lien : <CMS_SITE_URL>/apercu?jeton=<jeton>.
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError, friendlyError } from "@/lib/crm/service";

export const PREVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const previewHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function siteUrl(): string | null {
  const u = process.env.CMS_SITE_URL?.trim().replace(/\/+$/, "");
  return u && /^https?:\/\//.test(u) ? u : null;
}

export async function createPreview(sb: SupabaseClient, entryId: string, hours = 24): Promise<{ url: string; expires_at: string }> {
  const base = siteUrl();
  if (!base) throw new CrmError("Adresse du site non configurée (CMS_SITE_URL) : l'aperçu ne peut pas être ouvert.");
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await sb.rpc("cms_preview_create", { p_entry: entryId, p_token_hash: previewHash(token), p_hours: Math.min(24, Math.max(1, Math.round(hours))) });
  if (error) throw new CrmError(friendlyError(error));
  return { url: `${base}/apercu?jeton=${token}`, expires_at: data as string };
}

export async function revokePreviews(sb: SupabaseClient, entryId: string): Promise<number> {
  const { data, error } = await sb.rpc("cms_preview_revoke", { p_entry: entryId });
  if (error) throw new CrmError(friendlyError(error));
  return Number(data ?? 0);
}
