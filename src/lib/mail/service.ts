import "server-only";
// Service d'envoi partagé par tout le CRM. Voir docs/integrations/mail-service.md.
// Aucun module n'accède aux jetons ni à Gmail : ils appellent sendMail ou les fonctions ci-dessous.
import type { SupabaseClient } from "@supabase/supabase-js";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { CrmError } from "@/lib/crm/service";
import { decryptSecret, encryptSecret } from "./crypto";
import { GoogleError, GMAIL_SEND_SCOPE, gmailSend, refreshAccess, revokeToken, type GoogleClient, type TokenSet } from "./google";
import { buildMime } from "./mime";
import { MAX_ATTACHMENTS_BYTES, MAX_ATTACHMENTS_LABEL, isEmail, withSignature, type MailAccount, type MailMessage, type MailOrigin } from "./types";
import { htmlToText, renderEmailHtml } from "./render";

const BUCKET = "company-files";

export type MailConfig = GoogleClient & { tokenKey: string };

/** Lu à chaque appel : `null` tant que Google n'est pas configuré, sans bloquer le reste du CRM. */
export function mailConfig(): MailConfig | null {
  const clientId = process.env.GOOGLE_MAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_MAIL_CLIENT_SECRET;
  const tokenKey = process.env.MAIL_TOKEN_KEY;
  if (!clientId || !clientSecret || !tokenKey) return null;
  return { clientId, clientSecret, tokenKey };
}
function requireConfig() {
  const c = mailConfig();
  if (!c) throw new CrmError("Le système mail n'est pas encore configuré (voir docs/mail-configuration.md).");
  return c;
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(error.code === "P0001" ? error.message : `Opération mail impossible : ${error.message}`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS = "id, provider, email, display_name, status, is_default, scopes, signature, last_error, connected_at, disconnected_at";

export async function listAccounts(sb: SupabaseClient): Promise<MailAccount[]> {
  const { data, error } = await sb.from("mail_accounts").select(ACCOUNT_COLUMNS).order("is_default", { ascending: false }).order("connected_at", { ascending: false });
  if (error) throw new CrmError(`Lecture des comptes impossible : ${error.message}`);
  return (data ?? []) as MailAccount[];
}

export async function saveConnection(sb: SupabaseClient, t: TokenSet) {
  const c = requireConfig();
  if (!t.scopes.includes(GMAIL_SEND_SCOPE)) throw new CrmError("L'autorisation d'envoi n'a pas été accordée. Reconnectez et cochez l'envoi d'emails.");
  if (!t.refreshToken) throw new CrmError("Google n'a pas fourni d'accès durable. Reconnectez le compte.");
  if (!t.email) throw new CrmError("Google n'a pas indiqué l'adresse du compte.");
  return rpc<string>(sb, "mail_connect", {
    p_email: t.email,
    p_name: t.name ?? null,
    p_scopes: t.scopes,
    p_refresh_enc: encryptSecret(t.refreshToken, c.tokenKey),
    p_access_enc: encryptSecret(t.accessToken, c.tokenKey),
    p_expires: t.expiresAt,
  });
}

/** Coupe les envois d'abord, puis révoque chez Google : un échec de révocation est signalé, pas masqué. */
export async function disconnectAccount(sb: SupabaseClient, id: string) {
  z.uuid().parse(id);
  const c = mailConfig();
  const secret = await rpc<{ refresh_token_enc: string } | null>(sb, "mail_account_secret", { p_id: id });
  await rpc(sb, "mail_disconnect", { p_id: id });
  if (!secret || !c) return { revoked: !secret };
  try {
    return { revoked: await revokeToken(decryptSecret(secret.refresh_token_enc, c.tokenKey)) };
  } catch {
    return { revoked: false };
  }
}

export async function updateSignature(sb: SupabaseClient, id: string, signature: string) {
  z.uuid().parse(id);
  if (signature.length > 5000) throw new CrmError("Signature trop longue (5000 caractères maximum).");
  const { error } = await sb.from("mail_accounts").update({ signature }).eq("id", id);
  if (error) throw new CrmError(`Signature non enregistrée : ${error.message}`);
}

class AuthLost extends Error {}

/**
 * Vérification à la demande (espace Connecteurs) : redemande un accès à Google avec le jeton de
 * renouvellement. Succès = autorisation active confirmée. Refus = compte marqué « à reconnecter ».
 */
export async function verifyAccount(sb: SupabaseClient, id: string): Promise<{ ok: boolean; message: string }> {
  z.uuid().parse(id);
  const c = mailConfig();
  if (!c) return { ok: false, message: "Identifiants Google du module Mail absents du serveur." };
  try {
    await accessToken(sb, id, c, true);
    return { ok: true, message: "Google a confirmé l'autorisation d'envoi." };
  } catch (e) {
    if (e instanceof AuthLost) return { ok: false, message: "Google a refusé l'accès : reconnectez le compte." };
    return { ok: false, message: e instanceof Error && /injoignable|timeout|fetch/i.test(e.message) ? "Google n'a pas répondu. Réessayez plus tard." : "Vérification impossible pour le moment." };
  }
}

async function accessToken(sb: SupabaseClient, accountId: string, c: MailConfig, force = false) {
  const s = await rpc<{ refresh_token_enc: string; access_token_enc: string | null; access_token_expires_at: string | null } | null>(sb, "mail_account_secret", { p_id: accountId });
  if (!s) throw new AuthLost("Compte Gmail non connecté.");
  if (!force && s.access_token_enc && s.access_token_expires_at && Date.parse(s.access_token_expires_at) > Date.now() + 60_000) {
    return decryptSecret(s.access_token_enc, c.tokenKey);
  }
  try {
    const t = await refreshAccess(c, decryptSecret(s.refresh_token_enc, c.tokenKey));
    await rpc(sb, "mail_store_access", {
      p_id: accountId,
      p_access_enc: encryptSecret(t.accessToken, c.tokenKey),
      p_expires: t.expiresAt,
      p_refresh_enc: t.refreshToken ? encryptSecret(t.refreshToken, c.tokenKey) : null,
    });
    return t.accessToken;
  } catch (e) {
    if (e instanceof GoogleError && e.code === "revoked") {
      await rpc(sb, "mail_mark_reconnect", { p_id: accountId, p_error: e.message });
      throw new AuthLost(e.message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** HTML fourni par un module : seules les balises de mise en forme passent. Jamais de script ni d'image distante. */
export function safeHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li", "h1", "h2", "h3", "blockquote", "hr", "span", "div", "table", "tbody", "tr", "td", "th"],
    allowedAttributes: { a: ["href"], span: ["data-variable"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
  });
}

const addressList = z.array(z.string().refine(isEmail, "Adresse email invalide")).max(50, "50 destinataires maximum par champ");

export type DraftInput = {
  account_id?: string | null;
  company_id?: string | null;
  person_id?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** contenu mis en forme (éditeur) ; nettoyé ici avant d'être enregistré */
  html?: string | null;
  signature?: string;
  file_ids?: string[];
  in_reply_to?: string | null;
  references?: string | null;
  thread_id?: string | null;
  /** modèle d'origine (trace) et personnalisation collective */
  template_id?: string | null;
  collective?: boolean;
  /** version lue par le composeur : un enregistrement fait ailleurs entre-temps n'est jamais écrasé */
  expected_version?: number | null;
};

// Un brouillon peut être incomplet : les adresses saisies ne sont validées qu'à l'envoi.
const draftSchema = z.object({
  account_id: z.uuid().nullish(),
  company_id: z.uuid().nullish(),
  person_id: z.uuid().nullish(),
  to: z.array(z.string().max(320)).max(50),
  cc: z.array(z.string().max(320)).max(50).optional(),
  bcc: z.array(z.string().max(320)).max(50).optional(),
  subject: z.string().max(500),
  body: z.string().max(200000),
  html: z.string().max(500000).nullish(),
  signature: z.string().max(5000).optional(),
  file_ids: z.array(z.uuid()).max(20).optional(),
  in_reply_to: z.string().max(1000).nullish(),
  references: z.string().max(5000).nullish(),
  thread_id: z.string().max(200).nullish(),
  template_id: z.uuid().nullish(),
  collective: z.boolean().optional(),
  expected_version: z.number().int().min(0).nullish(),
});

export type DraftSave = (MailMessage & { conflict: false }) | { conflict: true; current: MailMessage };

export async function saveDraft(sb: SupabaseClient, id: string, input: DraftInput): Promise<DraftSave> {
  z.uuid().parse(id);
  const { expected_version, ...p } = draftSchema.parse(input);
  // avec un contenu mis en forme, la version texte est recalculée ici : texte et HTML disent la même chose
  const html = p.html ? safeHtml(p.html) : null;
  return rpc<DraftSave>(sb, "mail_save_draft", { p_id: id, p: { ...p, html, body: html ? htmlToText(html) : p.body }, p_expected_version: expected_version ?? null });
}

export async function listCompanyMail(sb: SupabaseClient, companyId: string) {
  z.uuid().parse(companyId);
  await rpc(sb, "mail_reap_stale", {});
  const { data, error } = await sb.from("mail_messages").select("id").eq("company_id", companyId).order("updated_at", { ascending: false }).limit(50);
  if (error) throw new CrmError(`Lecture des emails impossible : ${error.message}`);
  return Promise.all((data ?? []).map((r) => rpc<MailMessage>(sb, "mail_row", { p_id: r.id })));
}

export async function listRecentMail(sb: SupabaseClient, limit = 30) {
  await rpc(sb, "mail_reap_stale", {});
  const { data, error } = await sb.from("mail_messages").select("id, status, origin, to_addrs, subject, company_id, sent_at, last_error, updated_at").neq("status", "draft").order("updated_at", { ascending: false }).limit(limit);
  if (error) throw new CrmError(`Lecture des emails impossible : ${error.message}`);
  return data ?? [];
}

export const reopenMail = (sb: SupabaseClient, id: string) => rpc<MailMessage>(sb, "mail_reopen", { p_id: z.uuid().parse(id) });
export const discardMail = (sb: SupabaseClient, id: string) => rpc<null>(sb, "mail_discard", { p_id: z.uuid().parse(id) });
export const resolveUncertain = (sb: SupabaseClient, id: string, sent: boolean) => rpc<MailMessage>(sb, "mail_resolve_uncertain", { p_id: z.uuid().parse(id), p_sent: sent });

type Claim = {
  claimed: boolean;
  status?: string;
  message: MailMessage & { body_html: string | null };
  account?: { id: string; email: string; display_name: string | null };
  files?: { name: string; mime_type: string; size_bytes: number; storage_path: string }[];
  attachment_count?: number;
};

/**
 * Envoie un message déjà enregistré (brouillon ou en attente), une seule fois.
 * `claimed: false` : un autre appel s'en occupe ou s'en est occupé ; Gmail n'est pas appelé.
 * Le résultat renvoyé dit la vérité sur l'état : il ne faut jamais en déduire « livré » ni « lu ».
 */
export async function sendStored(sb: SupabaseClient, id: string): Promise<MailMessage> {
  const c = requireConfig();
  z.uuid().parse(id);
  const claim = await rpc<Claim>(sb, "mail_claim", { p_id: id });
  if (!claim.claimed) return claim.message;
  const fail = (code: string, message: string, uncertain = false) => rpc<MailMessage>(sb, "mail_mark_failed", { p_id: id, p_code: code, p_error: message, p_uncertain: uncertain });
  const m = claim.message;
  const accountId = claim.account!.id;

  // Tout ce qui précède l'appel à Gmail est un échec certain : le message n'est pas parti.
  let raw: Buffer;
  let token: string;
  try {
    for (const list of [m.to_addrs, m.cc_addrs, m.bcc_addrs]) addressList.parse(list);
    const files = claim.files ?? [];
    if (files.length !== claim.attachment_count) throw new CrmError("Une pièce jointe n'est plus disponible.");
    const total = files.reduce((n, f) => n + Number(f.size_bytes), 0);
    if (total > MAX_ATTACHMENTS_BYTES) throw new CrmError(`Pièces jointes trop lourdes : ${MAX_ATTACHMENTS_LABEL} maximum au total (limite de Gmail).`);
    const attachments = await Promise.all(files.map(async (f) => {
      const { data, error } = await sb.storage.from(BUCKET).download(f.storage_path);
      if (error || !data) throw new CrmError(`Pièce jointe illisible : ${f.name}`);
      return { name: f.name, mimeType: f.mime_type, data: Buffer.from(await data.arrayBuffer()) };
    }));
    raw = buildMime({
      from: { email: claim.account!.email, name: claim.account!.display_name },
      to: m.to_addrs,
      cc: m.cc_addrs,
      bcc: m.bcc_addrs,
      subject: m.subject,
      text: withSignature(m.body_text, m.signature),
      // même rendu que l'aperçu du composeur : styles en ligne, signature une seule fois
      html: m.body_html ? renderEmailHtml(safeHtml(m.body_html), m.signature) : null,
      inReplyTo: m.in_reply_to,
      references: m.references_hdr,
      attachments,
    });
    token = await accessToken(sb, accountId, c);
  } catch (e) {
    if (e instanceof AuthLost) return fail("reconnect", e.message);
    if (e instanceof CrmError || e instanceof GoogleError) return fail("prepare", e.message);
    if (e instanceof z.ZodError) return fail("invalid", e.issues[0]?.message ?? "Message invalide.");
    return fail("prepare", e instanceof Error && /Adresse|interdit|destinataire|Type/.test(e.message) ? e.message : "Préparation de l'envoi impossible.");
  }

  let out = await gmailSend(token, raw, m.provider_thread_id);
  if (out.kind === "failed" && out.retryAuth) {
    // 401 : Gmail n'a rien traité. Une seule nouvelle tentative, avec un accès renouvelé.
    try {
      out = await gmailSend(await accessToken(sb, accountId, c, true), raw, m.provider_thread_id);
    } catch (e) {
      return fail("reconnect", e instanceof Error ? e.message : "Reconnectez Gmail.");
    }
  }
  if (out.kind === "accepted") return rpc<MailMessage>(sb, "mail_mark_accepted", { p_id: id, p_message_id: out.messageId, p_thread_id: out.threadId });
  return fail(out.code, out.message, out.kind === "uncertain");
}

export type MailRequest = {
  /** Compte expéditeur ; par défaut, le compte actif. */
  accountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Nettoyé avant envoi. */
  html?: string;
  /** Fichiers de la fiche `companyId`, jamais d'autre stockage. */
  fileIds?: string[];
  origin: MailOrigin;
  companyId?: string;
  personId?: string;
  business?: { type: string; id: string };
  /** Une même clé ne crée qu'un seul message, même si le module rappelle sendMail. */
  dedupeKey?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Réservé à la file d'envoi (phase 3). Refusé tant qu'elle n'existe pas. */
  scheduledAt?: string;
};

const requestSchema = z.object({
  accountId: z.uuid().optional(),
  to: addressList.min(1, "Indiquez au moins un destinataire."),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().min(1, "Indiquez un objet.").max(500),
  text: z.string().max(200000),
  html: z.string().max(500000).optional(),
  fileIds: z.array(z.uuid()).max(20).optional(),
  origin: z.enum(["manual", "prospection", "appointment", "system"]),
  companyId: z.uuid().optional(),
  personId: z.uuid().optional(),
  business: z.object({ type: z.string().max(50), id: z.string().max(200) }).optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
  threadId: z.string().max(200).optional(),
  inReplyTo: z.string().max(1000).optional(),
  references: z.string().max(5000).optional(),
  scheduledAt: z.string().optional(),
});

/** Point d'entrée des modules : crée le message puis l'envoie tout de suite. */
export async function sendMail(sb: SupabaseClient, request: MailRequest): Promise<MailMessage & { duplicate: boolean }> {
  const r = requestSchema.parse(request);
  if (r.scheduledAt) throw new CrmError("L'envoi programmé n'est pas encore disponible.");
  const row = await rpc<MailMessage & { duplicate: boolean }>(sb, "mail_enqueue", {
    p: {
      account_id: r.accountId,
      origin: r.origin,
      company_id: r.companyId,
      person_id: r.personId,
      to: r.to,
      cc: r.cc,
      bcc: r.bcc,
      subject: r.subject,
      body: r.text,
      html: r.html,
      dedupe_key: r.dedupeKey,
      business_type: r.business?.type,
      business_id: r.business?.id,
      thread_id: r.threadId,
      in_reply_to: r.inReplyTo,
      references: r.references,
      ...(r.fileIds ? { file_ids: r.fileIds } : {}),
    },
  });
  if (row.duplicate) return row;
  return { ...(await sendStored(sb, row.id)), duplicate: false };
}
