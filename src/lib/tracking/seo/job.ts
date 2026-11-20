import "server-only";
// Synchronisation Search Console et Bing : passage quotidien (« seo ») et bouton « Synchroniser maintenant ».
// Sans session : tout passe par des fonctions à clé serveur. Chaque passage avance par petits lots dans un temps
// borné, enregistre son curseur après chaque lot et reprend là où il s'est arrêté ; relire un jour remplace ses
// lignes (aucun doublon). Un fournisseur en panne ou à reconnecter n'empêche pas l'autre.
import type { SupabaseClient } from "@supabase/supabase-js";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";
import { decryptSecret, serverRpcKey } from "@/lib/appointments/secrets";
import * as bingApi from "./bing";
import { BingError } from "./bing";
import * as gscApi from "./gsc";
import { GscError } from "./gsc";
import { BING_MAX_PAGES, addDays, dayOf, mergeRows, nextHistoryDays, planGsc, readBingCursor, sameSite, type BingCursor, type GscCursor, type SeoProvider, type SeoRow } from "./rules";

export const SEO_LABEL: Record<SeoProvider, string> = { gsc: "Search Console", bing: "Bing Webmaster Tools" };

export type SeoOutcome = {
  provider: SeoProvider;
  /** ok : lot écrit ; skipped : rien à faire (non connecté, propriété à choisir) ; reconnect / error : voir message */
  status: "ok" | "skipped" | "reconnect" | "error";
  message: string;
  /** false : il reste de l'historique à importer (le prochain passage continue) */
  done: boolean;
  rows: number;
  connected: boolean;
};

type Connection = { provider: SeoProvider; site_url: string | null; status: string; cursor: unknown; history_done_at: string | null; last_sync_at: string | null; secret_enc: string };

export type SeoDeps = {
  now: () => number;
  decrypt: (enc: string) => string;
  gsc: Pick<typeof gscApi, "accessToken" | "queryDay" | "listSites">;
  bing: Pick<typeof bingApi, "listSites" | "siteTotals" | "queryStats" | "pageStats" | "pageQueryStats">;
};
const DEFAULTS: SeoDeps = { now: () => Date.now(), decrypt: decryptSecret, gsc: gscApi, bing: bingApi };

/** Jours Search Console lus en parallèle (une requête par jour, comme Google le recommande). */
const GSC_PARALLEL = 5;
const BING_PARALLEL = 3;
const UPSERT_CHUNK = 20_000;

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, { p_server_key: serverRpcKey(), ...args });
  // message de la base (les nôtres) : jamais de secret ; l'appelant le remplace par une phrase lisible
  if (error) throw new Error(`base:${error.code ?? "?"}`);
  return data as T;
}

const connection = (sb: SupabaseClient, provider: SeoProvider) => rpc<Connection | null>(sb, "seo_server_connection", { p_provider: provider });

async function upsert(sb: SupabaseClient, provider: SeoProvider, rows: SeoRow[], replaceDays: string[] | null = null): Promise<number> {
  if (!rows.length && !replaceDays?.length) return 0;
  if (rows.length <= UPSERT_CHUNK || replaceDays) return rpc<number>(sb, "seo_server_upsert", { p_provider: provider, p_rows: rows, p_replace_days: replaceDays });
  let n = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) n += await rpc<number>(sb, "seo_server_upsert", { p_provider: provider, p_rows: rows.slice(i, i + UPSERT_CHUNK), p_replace_days: null });
  return n;
}

const progress = (sb: SupabaseClient, provider: SeoProvider, cursor: GscCursor | BingCursor | Record<string, never> | null, o: { historyDone?: boolean; synced?: boolean } = {}) =>
  rpc<void>(sb, "seo_server_progress", { p_provider: provider, p_cursor: cursor, p_history_done: !!o.historyDone, p_synced: !!o.synced });

/** Erreur → état à afficher. Seuls nos propres messages sortent : jamais celui d'une erreur inconnue. */
function classify(e: unknown): { status: "reconnect" | "error"; message: string } {
  if (e instanceof GscError) return { status: e.kind === "reauth" ? "reconnect" : "error", message: e.message };
  if (e instanceof BingError) return { status: e.kind === "auth" ? "reconnect" : "error", message: e.message };
  if (e instanceof SecretUnreadable) return { status: "reconnect", message: e.message };
  return { status: "error", message: "Synchronisation interrompue : elle reprendra au prochain passage." };
}

class SecretUnreadable extends Error {
  constructor() {
    super("Accès enregistré illisible (secret serveur modifié ?) : reconnectez.");
  }
}

function secretOf(conn: Connection, d: SeoDeps): string {
  try {
    return d.decrypt(conn.secret_enc);
  } catch {
    throw new SecretUnreadable();
  }
}

// ---------------------------------------------------------------------------
// Search Console : d'abord les derniers jours (provisoires, toujours relus), puis l'historique en remontant
// ---------------------------------------------------------------------------
async function syncGsc(sb: SupabaseClient, conn: Connection, deadline: number, d: SeoDeps): Promise<Pick<SeoOutcome, "done" | "rows" | "message">> {
  const site = conn.site_url as string;
  const token = await d.gsc.accessToken(secretOf(conn, d));
  const plan = planGsc(conn.cursor, dayOf(d.now()));
  let cursor = plan.cursor;
  let rows = 0;
  const readDays = async (days: string[]) => {
    const results = await Promise.all(days.map((day) => d.gsc.queryDay(token, site, day)));
    for (let i = 0; i < days.length; i++) rows += await upsert(sb, "gsc", mergeRows(results[i]), [days[i]]);
  };

  let recentDone = true;
  for (let i = 0; i < plan.recent.length; i += GSC_PARALLEL) {
    if (i > 0 && d.now() > deadline) { recentDone = false; break; }
    const days = plan.recent.slice(i, i + GSC_PARALLEL);
    await readDays(days);
    cursor = { ...cursor, recent_to: days[days.length - 1] };
    await progress(sb, "gsc", cursor);
  }

  let historyDone = !!conn.history_done_at;
  while (recentDone && !historyDone) {
    const days = nextHistoryDays(cursor, GSC_PARALLEL);
    if (!days.length) { historyDone = true; break; }
    if (d.now() > deadline) break;
    await readDays(days);
    cursor = { ...cursor, history_until: addDays(days[days.length - 1], -1) };
    await progress(sb, "gsc", cursor);
  }
  await progress(sb, "gsc", cursor, { historyDone, synced: recentDone });
  const done = recentDone && historyDone;
  return {
    done, rows,
    message: done ? `Search Console à jour jusqu'au ${plan.end}.`
      : `Import de l'historique en cours : déjà remonté jusqu'au ${cursor.history_until ? addDays(cursor.history_until, 1) : plan.recent[0]}, objectif ${cursor.floor}.`,
  };
}

// ---------------------------------------------------------------------------
// Bing : chaque appel rend tout l'historique disponible. Un cycle = total du site, requêtes, pages, puis les
// requêtes de chaque page principale ; le curseur retient l'étape et la page en cours.
// ---------------------------------------------------------------------------
async function syncBing(sb: SupabaseClient, conn: Connection, deadline: number, d: SeoDeps): Promise<Pick<SeoOutcome, "done" | "rows" | "message">> {
  const site = conn.site_url as string;
  const key = secretOf(conn, d);
  let c = readBingCursor(conn.cursor);
  let rows = 0;
  const over = () => d.now() > deadline;

  if (c.phase === "totals") {
    rows += await upsert(sb, "bing", await d.bing.siteTotals(key, site));
    c = { phase: "queries", pages: [], index: 0 };
    await progress(sb, "bing", c);
  }
  if (c.phase === "queries" && !over()) {
    rows += await upsert(sb, "bing", await d.bing.queryStats(key, site));
    c = { phase: "pages", pages: [], index: 0 };
    await progress(sb, "bing", c);
  }
  if (c.phase === "pages" && !over()) {
    const pages = await d.bing.pageStats(key, site);
    rows += await upsert(sb, "bing", pages.rows);
    c = { phase: "page_queries", pages: pages.urls.slice(0, BING_MAX_PAGES), index: 0 };
    await progress(sb, "bing", c);
  }
  while (c.phase === "page_queries" && c.index < c.pages.length && !over()) {
    const batch = c.pages.slice(c.index, c.index + BING_PARALLEL);
    const results = await Promise.all(batch.map((url) => d.bing.pageQueryStats(key, site, url)));
    for (const r of results) rows += await upsert(sb, "bing", r);
    c = { ...c, index: c.index + batch.length };
    await progress(sb, "bing", c);
  }
  const done = c.phase === "page_queries" && c.index >= c.pages.length;
  // cycle terminé : curseur remis à zéro, le prochain passage relit tout (Bing ne rend que l'historique complet)
  if (done) await progress(sb, "bing", {}, { historyDone: true, synced: true });
  return {
    done, rows,
    message: done ? "Bing à jour : tout l'historique disponible est importé."
      : c.phase === "page_queries" ? `Import Bing en cours : ${c.index} page(s) sur ${c.pages.length}.` : "Import Bing en cours.",
  };
}

/** Synchronise UN fournisseur jusqu'à `deadline` (horloge en ms). Ne lève jamais : l'issue est dans le résultat et en base. */
export async function syncProvider(sb: SupabaseClient, provider: SeoProvider, opts: { deadline: number; deps?: Partial<SeoDeps> }): Promise<SeoOutcome> {
  const d = { ...DEFAULTS, ...opts.deps };
  const base = { provider, rows: 0, done: false };
  let conn: Connection | null;
  try {
    conn = await connection(sb, provider);
  } catch {
    return { ...base, status: "error", message: "Lecture de la connexion impossible.", connected: false };
  }
  if (!conn) return { ...base, status: "skipped", message: `${SEO_LABEL[provider]} n'est pas connecté.`, done: true, connected: false };
  if (!conn.site_url) return { ...base, status: "skipped", message: "Choisissez d'abord le site à suivre.", connected: true };
  try {
    const r = provider === "gsc" ? await syncGsc(sb, conn, opts.deadline, d) : await syncBing(sb, conn, opts.deadline, d);
    return { provider, status: "ok", connected: true, ...r };
  } catch (e) {
    const { status, message } = classify(e);
    await rpc(sb, "seo_server_fail", { p_provider: provider, p_status: status, p_error: message }).catch(() => undefined);
    return { ...base, status, message, connected: true };
  }
}

/** Passage planifié « seo » : les deux fournisseurs, chacun avec sa part du temps. */
export async function seoJob(sb: SupabaseClient, opts: { budgetMs?: number; deps?: Partial<SeoDeps> } = {}) {
  if (!appointmentsSecretOrNull()) return { skipped: "Secret serveur absent (APPOINTMENTS_SECRET)" };
  const budget = opts.budgetMs ?? 15_000;
  const start = (opts.deps?.now ?? Date.now)();
  const gsc = await syncProvider(sb, "gsc", { deadline: start + budget * 0.6, deps: opts.deps });
  const bing = await syncProvider(sb, "bing", { deadline: start + budget, deps: opts.deps });
  if (!gsc.connected && !bing.connected) return { skipped: "Search Console et Bing ne sont pas connectés" };
  const failed = [gsc, bing].filter((o) => o.status === "reconnect" || o.status === "error");
  if (failed.length) throw new Error(failed.map((o) => `${SEO_LABEL[o.provider]} : ${o.message}`).join(" · "));
  const brief = (o: SeoOutcome) => ({ status: o.status, done: o.done, rows: o.rows, message: o.message });
  return { gsc: brief(gsc), bing: brief(bing) };
}

/** « Vérifier » : un appel de lecture au fournisseur, sans rien importer. Met l'état à jour en base. */
export async function verifyProvider(sb: SupabaseClient, provider: SeoProvider, deps: Partial<SeoDeps> = {}): Promise<{ ok: boolean; message: string }> {
  const d = { ...DEFAULTS, ...deps };
  const conn = await connection(sb, provider).catch(() => null);
  if (!conn) return { ok: false, message: `${SEO_LABEL[provider]} n'est pas connecté.` };
  try {
    const secret = secretOf(conn, d);
    const sites = provider === "gsc" ? await d.gsc.listSites(await d.gsc.accessToken(secret)) : await d.bing.listSites(secret);
    await progress(sb, provider, null);
    if (!conn.site_url) return { ok: true, message: `Accès confirmé : ${sites.length} site(s) visible(s). Choisissez celui à suivre.` };
    if (!sites.some((s) => (provider === "gsc" ? s === conn.site_url : sameSite(s, conn.site_url as string)))) {
      return { ok: false, message: "Accès confirmé, mais le site suivi n'est plus visible avec ce compte." };
    }
    return { ok: true, message: `Accès confirmé en lecture seule (${sites.length} site(s) visible(s)).` };
  } catch (e) {
    const { status, message } = classify(e);
    await rpc(sb, "seo_server_fail", { p_provider: provider, p_status: status, p_error: message }).catch(() => undefined);
    return { ok: false, message };
  }
}

/**
 * Déconnexion (session du propriétaire). Le jeton Google n'est révoqué chez Google que si Search Console a son
 * propre client OAuth : avec un client partagé (Agenda, Gmail), révoquer pourrait couper aussi ces accès ; le
 * jeton est alors seulement effacé du CRM. Une clé Bing ne se révoque que dans Bing Webmaster Tools.
 */
export async function disconnectProvider(sb: SupabaseClient, provider: SeoProvider): Promise<{ revoked: boolean }> {
  let revoked = false;
  if (provider === "gsc" && gscApi.gscConfig()?.dedicated) {
    const conn = await connection(sb, provider).catch(() => null);
    if (conn) {
      try {
        revoked = await gscApi.revoke(decryptSecret(conn.secret_enc));
      } catch {
        revoked = false;
      }
    }
  }
  const { error } = await sb.rpc("seo_disconnect", { p_provider: provider });
  if (error) throw new Error("Déconnexion refusée par la base.");
  return { revoked };
}
