import "server-only";
// États de Search Console et de Bing pour l'espace Connecteurs : lus en base uniquement (aucun appel aux
// fournisseurs à l'ouverture de la page). Aucun secret : la table des secrets n'est pas lisible d'ici.
import type { SupabaseClient } from "@supabase/supabase-js";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";
import type { Connector, ConnectorKey } from "@/lib/connectors/types";
import { gscConfig } from "./gsc";
import { SEO_CONNECTOR_KEY, addDays, readBingCursor, readGscCursor, type SeoProvider } from "./rules";

type Check = { at: string; ok: boolean; message: string | null } | null;
type Base = Pick<Connector, "key" | "name" | "usage" | "feeds" | "links">;

export const SEO_BASE: Record<SeoProvider, Base> = {
  gsc: {
    key: SEO_CONNECTOR_KEY.gsc, name: "Google Search Console", usage: "Référencement du site sur Google",
    feeds: ["Clics, impressions, taux de clic et position moyenne, par jour, par page et par requête", "Historique complet à la première connexion (environ 16 mois), puis mise à jour quotidienne"],
    links: [{ label: "Passages planifiés", href: "/parametres/passages" }],
  },
  bing: {
    key: SEO_CONNECTOR_KEY.bing, name: "Bing Webmaster Tools", usage: "Référencement du site sur Bing",
    feeds: ["Clics et impressions du site par jour", "Clics, impressions et position moyenne des requêtes et des pages principales (mis à jour chaque semaine par Bing)", "Requêtes de chaque page principale"],
    links: [{ label: "Passages planifiés", href: "/parametres/passages" }],
  },
};

const newer = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || a > b);
const fmtDay = (day: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));

export async function seoConnector(sb: SupabaseClient, provider: SeoProvider, check: Check): Promise<Connector> {
  const base = SEO_BASE[provider];
  const [conn, count] = await Promise.all([
    sb.from("seo_connections").select("provider, site_url, account_label, sites, status, last_error, connected_at, last_sync_at, history_done_at, cursor, updated_at").eq("provider", provider).maybeSingle(),
    sb.from("seo_daily").select("day", { count: "exact", head: true }).eq("provider", provider).eq("demo", false),
  ]);
  if (conn.error) throw new Error("lecture");
  const r = conn.data as Record<string, unknown> | null;
  const server = !!appointmentsSecretOrNull();
  const configured = server && (provider === "bing" || !!gscConfig());
  const gsc = provider === "gsc";
  const site = (r?.site_url as string | null) ?? null;
  const sites = Array.isArray(r?.sites) ? (r.sites as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const historyDone = !!r?.history_done_at;
  const cur = gsc ? readGscCursor(r?.cursor) : null;
  const historyReached = cur?.history_until ? addDays(cur.history_until, 1) : null;
  const bingCur = !gsc && r ? readBingCursor(r.cursor) : null;
  const connectHref = gsc && configured ? "/api/tracking/seo/google/connect" : null;
  const lastSync = (r?.last_sync_at as string | null) ?? null;
  const rows = count.error ? null : (count.count ?? 0);
  const historyLabel = !r ? "—" : historyDone ? "Importé"
    : gsc ? (historyReached ? `En cours : remonté jusqu'au ${fmtDay(historyReached)}` : "Pas encore commencé")
      : bingCur?.phase === "page_queries" ? `En cours : ${bingCur.index} page(s) sur ${bingCur.pages.length}` : "Pas encore commencé";

  const common = {
    ...base, lastCheck: check, canVerify: !!r && configured, reconnectHref: connectHref,
    account: r ? site ?? (r.account_label as string | null) ?? "Site à choisir" : null,
    permissions: r ? [gsc ? "Lecture seule des statistiques de recherche (webmasters.readonly)" : "Lecture des statistiques du site avec votre clé API (le CRM n'envoie que des demandes de lecture)"] : [],
    settings: [
      ...(r ? [
        { label: gsc ? "Propriété suivie" : "Site suivi", value: site ?? "À choisir", tone: site ? undefined : ("warn" as const) },
        { label: "Historique", value: historyLabel, tone: historyDone ? ("ok" as const) : ("muted" as const) },
        { label: "Lignes importées", value: rows === null ? "—" : new Intl.NumberFormat("fr-FR").format(rows), tone: "muted" as const },
      ] : []),
      ...(gsc ? [{ label: "Identifiants Google côté serveur", value: gscConfig() ? "Présents" : "Absents (GOOGLE_SEARCH_CONSOLE_CLIENT_ID / SECRET)", tone: gscConfig() ? ("ok" as const) : ("warn" as const) }] : []),
      { label: "Secret serveur (chiffrement)", value: server ? "Présent" : "Absent (APPOINTMENTS_SECRET)", tone: server ? ("ok" as const) : ("warn" as const) },
    ],
    disconnect: r ? {
      label: gsc ? "Déconnecter Search Console" : "Déconnecter Bing",
      effect: gsc
        ? "La synchronisation quotidienne s'arrête et le jeton est effacé du CRM. Les chiffres déjà importés restent."
        : "La synchronisation quotidienne s'arrête et la clé est effacée du CRM (elle reste valable chez Bing tant que vous ne la supprimez pas). Les chiffres déjà importés restent.",
    } : null,
    external: gsc
      ? "Le client OAuth, l'API Search Console et l'URI de redirection se règlent dans Google Cloud ; les variables chez l'hébergeur. Voir docs/integrations/search-console-bing.md."
      : "La clé API se génère dans Bing Webmaster Tools (Paramètres › Accès API). Voir docs/integrations/search-console-bing.md.",
    lastSuccess: lastSync ? { at: lastSync, label: "Dernière synchronisation" } : null,
    seo: { provider, configured, connected: !!r, siteUrl: site, sites, historyDone, historyReached, rows },
  } satisfies Partial<Connector>;

  if (!r) {
    const note = !server ? "Secret serveur absent (APPOINTMENTS_SECRET)." : gsc && !gscConfig() ? "Identifiants Google absents du serveur." : null;
    return { ...common, state: "not_connected", problem: null, note,
      primary: connectHref ? { kind: "link", label: "Connecter", href: connectHref } : { kind: "manage", label: configured ? "Connecter" : "Configurer" } };
  }
  const at = (r.updated_at as string | null) ?? null;
  if (r.status === "reconnect") {
    const message = (r.last_error as string | null) ?? (gsc ? "Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console." : "Clé API refusée par Bing : reconnectez avec une nouvelle clé.");
    return { ...common, state: "reconnect", problem: { at, message }, note: null,
      primary: connectHref ? { kind: "link", label: "Reconnecter", href: connectHref } : { kind: "manage", label: "Reconnecter" } };
  }
  if (!site) return { ...common, state: "to_verify", problem: null, note: "Choisissez le site à suivre.", primary: { kind: "manage", label: "Choisir" } };
  if (r.status === "error") {
    return { ...common, state: "sync_error", problem: { at, message: (r.last_error as string | null) ?? "Dernière synchronisation en échec." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  }
  if (check && !check.ok && newer(check.at, lastSync)) {
    return { ...common, state: "sync_error", problem: { at: check.at, message: check.message ?? "Dernière vérification en échec." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  }
  return { ...common, state: "connected", problem: null, note: historyDone ? null : lastSync ? "Import de l'historique en cours." : "Première synchronisation à lancer.", primary: { kind: "manage", label: "Gérer" } };
}

export const seoKeys: ConnectorKey[] = [SEO_CONNECTOR_KEY.gsc, SEO_CONNECTOR_KEY.bing];
