import "server-only";
// Comptes lemlist des clients : connexion (clé testée puis chiffrée), déconnexion, vérification, et accès à la clé
// d'UN compte pour les autres lots. La clé déchiffrée ne quitte jamais le serveur et n'est jamais journalisée.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/service";
import { decryptSecret, encryptSecret } from "@/lib/mail/crypto";
import { getTeam, LemlistError } from "./client";
import type { LemlistAccount, LemlistClientOption } from "./types";

/** Clé de chiffrement partagée avec le module Mail (MAIL_TOKEN_KEY). `null` tant qu'elle manque. */
export function lemlistTokenKey(): string | null {
  const k = process.env.MAIL_TOKEN_KEY;
  if (!k) return null;
  try {
    return Buffer.from(k, "base64").length === 32 ? k : null;
  } catch {
    return null;
  }
}
function requireTokenKey() {
  const k = lemlistTokenKey();
  if (!k) throw new CrmError("Chiffrement indisponible : la variable MAIL_TOKEN_KEY manque sur le serveur.");
  return k;
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(error.code === "P0001" ? error.message : "Opération lemlist impossible.");
  return data as T;
}

/** Comptes visibles (fiche hors corbeille), hors comptes déconnectés. */
export async function listLemlistAccounts(sb: SupabaseClient): Promise<LemlistAccount[]> {
  return rpc<LemlistAccount[]>(sb, "lemlist_accounts_list", {});
}

export async function getLemlistAccount(sb: SupabaseClient, id: string): Promise<LemlistAccount | null> {
  const rows = await rpc<LemlistAccount[]>(sb, "lemlist_accounts_list", { p_id: z.uuid().parse(id) });
  return rows[0] ?? null;
}

/** Fiches clients proposées au rattachement : vente gagnée, non fusionnées, hors corbeille. */
export async function listClientOptions(sb: SupabaseClient): Promise<LemlistClientOption[]> {
  return rpc<LemlistClientOption[]>(sb, "lemlist_client_options", {});
}

const connectInput = z.object({
  companyId: z.uuid({ message: "Choisissez la fiche du client." }),
  apiKey: z.string().trim().min(10, { message: "Collez la clé API lemlist du client." }).max(300, { message: "Clé API trop longue." }),
});

/** Teste la clé chez lemlist, puis l'enregistre chiffrée et rattache le compte à la fiche. */
export async function connectLemlistAccount(sb: SupabaseClient, input: { companyId: string; apiKey: string }): Promise<LemlistAccount> {
  const { companyId, apiKey } = connectInput.parse(input);
  const tokenKey = requireTokenKey();
  let team;
  try {
    team = await getTeam(apiKey);
  } catch (e) {
    if (e instanceof LemlistError) throw new CrmError(e.code === "auth" ? "lemlist a refusé cette clé API. Vérifiez-la (lemlist › Réglages › Intégrations) et recollez-la." : `${e.message} Le compte n'a pas été ajouté.`);
    throw e;
  }
  const id = await rpc<string>(sb, "lemlist_connect", { p_company: companyId, p_team_id: team.id, p_team_name: team.name, p_key_enc: encryptSecret(apiKey, tokenKey) });
  const account = await getLemlistAccount(sb, id);
  if (!account) throw new CrmError("Compte enregistré mais illisible. Rechargez la page.");
  return account;
}

export async function disconnectLemlistAccount(sb: SupabaseClient, id: string) {
  await rpc(sb, "lemlist_disconnect", { p_id: z.uuid().parse(id) });
  return { disconnected: true };
}

/** Clé déchiffrée d'UN compte (connecté ou à reconnecter), retrouvée par le serveur à partir de l'identifiant du compte. */
async function accountKey(sb: SupabaseClient, id: string): Promise<string> {
  const enc = await rpc<string | null>(sb, "lemlist_account_key", { p_id: id });
  if (!enc) throw new CrmError("Compte lemlist introuvable ou déconnecté.");
  try {
    return decryptSecret(enc, requireTokenKey());
  } catch (e) {
    if (e instanceof CrmError) throw e;
    throw new CrmError("Clé lemlist illisible : reconnectez ce compte.");
  }
}

export type AccountOutcome<T> = { ok: true; data: T } | { ok: false; code: LemlistError["code"]; message: string; retryAfterSec: number | null };

/**
 * Exécute un appel lemlist avec la clé d'UN compte et enregistre le résultat pour ce compte seul :
 * clé refusée → « À reconnecter » ; erreur passagère (débit, panne) → notée, état inchangé. Les autres comptes
 * ne sont jamais touchés. Ne lève pas pour une erreur lemlist : l'appelant affiche le message du compte concerné.
 */
export async function withLemlistAccount<T>(sb: SupabaseClient, id: string, fn: (apiKey: string, account: LemlistAccount) => Promise<T>): Promise<AccountOutcome<T>> {
  const account = await getLemlistAccount(sb, id);
  if (!account || account.status === "disconnected") throw new CrmError("Compte lemlist introuvable ou déconnecté.");
  const apiKey = await accountKey(sb, account.id);
  try {
    const data = await fn(apiKey, account);
    await rpc(sb, "lemlist_account_result", { p_id: account.id, p_kind: "ok", p_error: null });
    return { ok: true, data };
  } catch (e) {
    if (!(e instanceof LemlistError)) throw e;
    await rpc(sb, "lemlist_account_result", { p_id: account.id, p_kind: e.code === "auth" ? "auth" : "other", p_error: e.message });
    return { ok: false, code: e.code, message: e.message, retryAfterSec: e.retryAfterSec };
  }
}

/** Vérification à la demande : la clé répond-elle toujours, et pour la même équipe ? */
export async function verifyLemlistAccount(sb: SupabaseClient, id: string): Promise<{ ok: boolean; message: string; account: LemlistAccount | null }> {
  const r = await withLemlistAccount(sb, z.uuid().parse(id), async (key, account) => {
    const team = await getTeam(key);
    if (team.id !== account.team_id) throw new LemlistError("auth", "Cette clé appartient désormais à une autre équipe lemlist : reconnectez le compte.");
    return team;
  });
  const account = await getLemlistAccount(sb, id);
  return r.ok ? { ok: true, message: `Clé acceptée par lemlist (${r.data.name || "équipe sans nom"}).`, account } : { ok: false, message: r.message, account };
}
