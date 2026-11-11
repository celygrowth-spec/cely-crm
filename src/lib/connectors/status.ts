import "server-only";
// États des connecteurs À L'OUVERTURE de la page : uniquement ce que le CRM a déjà enregistré
// (tables de chaque module, dernières vérifications). Aucun appel aux fournisseurs ici : la page ne
// bloque jamais sur Google ou Fireflies. Chaque connecteur est lu séparément : une lecture en échec
// donne « État non vérifiable » pour lui seul.
import type { SupabaseClient } from "@supabase/supabase-js";
import { appointmentsSecretOrNull, googleConfig } from "@/lib/appointments/config";
import { firefliesApiKey, firefliesWebhookSecret } from "@/lib/fireflies/config";
import { mailConfig } from "@/lib/mail/service";
import type { Connector, ConnectorKey, McpGrant } from "./types";

type Row = Record<string, unknown>;
type Checks = Partial<Record<ConnectorKey, { at: string; ok: boolean; message: string | null }>>;
const newer = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || a > b);
const dated = (at: string | null | undefined, label: string) => (at ? { at, label } : null);

async function checks(sb: SupabaseClient): Promise<Checks> {
  const { data } = await sb.from("connector_checks").select("key, checked_at, ok, message");
  return Object.fromEntries((data ?? []).map((r: Row) => [r.key, { at: r.checked_at as string, ok: r.ok as boolean, message: (r.message as string) ?? null }]));
}

function unknown(base: Pick<Connector, "key" | "name" | "usage" | "feeds" | "links">, why: string): Connector {
  return {
    ...base, state: "unknown", account: null, lastSuccess: null, problem: { at: null, message: why }, note: why,
    primary: { kind: "manage", label: "Gérer" }, lastCheck: null, permissions: [], settings: [], canVerify: false,
    reconnectHref: null, disconnect: null, external: null,
  };
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const GMAIL = {
  key: "gmail" as const, name: "Gmail", usage: "Envoi des emails du CRM",
  feeds: ["Emails envoyés depuis une fiche, avec pièces jointes", "Emails automatiques des autres modules (confirmations et rappels de rendez-vous, s'ils sont activés)", "Historique des échanges sur la fiche (envois uniquement : la boîte de réception n'est pas lue)"],
  links: [{ label: "Ouvrir Mail", href: "/mail" }],
};

async function gmail(sb: SupabaseClient, c: Checks): Promise<Connector> {
  const [acc, ok, ko] = await Promise.all([
    sb.from("mail_accounts").select("id, email, status, is_default, scopes, last_error, connected_at, disconnected_at, updated_at").order("is_default", { ascending: false }).order("connected_at", { ascending: false }),
    sb.from("mail_messages").select("sent_at").eq("status", "accepted").order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("mail_messages").select("updated_at, last_error, status").in("status", ["failed", "uncertain"]).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (acc.error) return unknown(GMAIL, "Lecture des comptes Gmail impossible.");
  const accounts = (acc.data ?? []) as Row[];
  const active = accounts.find((a) => a.status !== "disconnected") ?? null;
  const configured = !!mailConfig();
  const lastSent = (ok.data?.sent_at as string | undefined) ?? null;
  const failed = ko.data as Row | null;
  const check = c.gmail ?? null;
  const base = {
    ...GMAIL, lastCheck: check, canVerify: !!active && configured,
    reconnectHref: configured ? `/api/mail/oauth/start${active ? `?hint=${encodeURIComponent(String(active.email))}` : ""}` : null,
    permissions: active ? ((active.scopes as string[]) ?? []).map(scopeLabel).filter(Boolean) as string[] : [],
    settings: [
      { label: "Compte par défaut", value: active ? String(active.email) : "Aucun" },
      ...accounts.filter((a) => a !== active).map((a) => ({ label: "Autre compte", value: `${a.email} · ${a.status === "disconnected" ? "déconnecté" : a.status === "needs_reconnect" ? "à reconnecter" : "connecté"}`, tone: "muted" as const })),
      { label: "Identifiants Google côté serveur", value: configured ? "Présents" : "Absents (GOOGLE_MAIL_CLIENT_ID, GOOGLE_MAIL_CLIENT_SECRET, MAIL_TOKEN_KEY)", tone: configured ? ("ok" as const) : ("warn" as const) },
    ],
    disconnect: active ? { label: "Déconnecter Gmail", effect: "Les prochains envois qui dépendent de Gmail sont suspendus et l'accès est révoqué chez Google. Les emails déjà envoyés restent dans l'historique des fiches." } : null,
    external: "Le client OAuth et l'écran de consentement se gèrent dans Google Cloud ; les variables dans Vercel.",
    lastSuccess: dated(lastSent, "Dernier envoi réussi"),
    account: active ? String(active.email) : null,
  };
  if (!active) {
    return { ...base, state: "not_connected", problem: null, note: configured ? null : "Identifiants Google absents du serveur.", primary: configured ? { kind: "link", label: "Connecter", href: "/api/mail/oauth/start" } : { kind: "manage", label: "Configurer" } };
  }
  if (active.status === "needs_reconnect") {
    return { ...base, state: "reconnect", problem: { at: (active.updated_at as string) ?? null, message: "Google a refusé l'accès (révoqué ou expiré)." }, note: null, primary: { kind: "link", label: "Reconnecter", href: base.reconnectHref ?? "/mail" } };
  }
  if (check && !check.ok && newer(check.at, lastSent)) {
    return { ...base, state: "sync_error", problem: { at: check.at, message: check.message ?? "Dernière vérification en échec." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  }
  if (failed && newer(failed.updated_at as string, lastSent)) {
    return { ...base, state: "sync_error", problem: { at: failed.updated_at as string, message: failed.status === "uncertain" ? "Dernier envoi incertain : à confirmer dans Mail." : "Dernier envoi en échec." }, note: null, primary: { kind: "link", label: "Voir", href: "/mail" } };
  }
  // autorisation confirmée par Google à la connexion, puis par chaque envoi ou vérification réussis
  return { ...base, state: "connected", problem: null, note: lastSent ? null : `Autorisé le ${fmt(active.connected_at as string)}`, primary: { kind: "manage", label: "Gérer" } };
}

function scopeLabel(s: string) {
  if (s.endsWith("gmail.send")) return "Envoyer des emails en votre nom (pas de lecture de la boîte)";
  if (s === "email" || s.endsWith("userinfo.email")) return "Connaître l'adresse du compte";
  if (s === "profile" || s.endsWith("userinfo.profile")) return "Connaître le nom du compte";
  if (s === "openid") return null;
  if (s.includes("calendar.events")) return "Créer et modifier les événements de l'agenda choisi";
  if (s.includes("calendar.readonly") || s.includes("calendar.calendarlist")) return "Lire la liste des agendas";
  if (s.includes("calendar.freebusy")) return "Voir les disponibilités (occupé / libre)";
  return s.replace("https://www.googleapis.com/auth/", "");
}
const fmt = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(iso));

// ---------------------------------------------------------------------------
// Google Agenda (et Google Meet)
// ---------------------------------------------------------------------------

const GCAL = {
  key: "google_calendar" as const, name: "Google Agenda", usage: "Rendez-vous et points projet",
  feeds: ["Disponibilités de la page de réservation (agendas vérifiés)", "Événements des rendez-vous et des points projet", "Liens Google Meet des types de rendez-vous qui l'activent", "Signalement des déplacements faits directement dans Google"],
  links: [{ label: "Choisir les agendas et suivre la synchronisation", href: "/parametres/connecteurs/google-agenda" }],
};

async function calendar(sb: SupabaseClient, c: Checks): Promise<Connector> {
  const [conn, backlog, meet] = await Promise.all([
    sb.from("appt_google_connection").select("google_email, scopes, calendars, check_calendar_ids, destination_calendar_id, status, last_error, connected_at, updated_at, events_synced_at, events_sync_error").maybeSingle(),
    sb.from("appt_booking_overview").select("id", { count: "exact", head: true }).eq("calendar_out_of_sync", true),
    sb.from("appt_event_types").select("id", { count: "exact", head: true }).eq("google_meet", true),
  ]);
  if (conn.error) return unknown(GCAL, "Lecture de la connexion Google impossible.");
  const r = conn.data as Row | null;
  const configured = !!googleConfig() && !!appointmentsSecretOrNull();
  const check = c.google_calendar ?? null;
  const cals = ((r?.calendars as { id: string; summary?: string }[] | null) ?? []);
  const name = (id: string | null | undefined) => (id ? cals.find((x) => x.id === id)?.summary ?? id : null);
  const out = backlog.count ?? 0;
  const base = {
    ...GCAL, lastCheck: check, canVerify: !!r && configured,
    reconnectHref: configured ? "/api/rendez-vous/google/connect" : null,
    permissions: r ? String(r.scopes ?? "").split(" ").filter(Boolean).map(scopeLabel).filter(Boolean) as string[] : [],
    settings: r ? [
      { label: "Agenda de destination", value: name(r.destination_calendar_id as string) ?? "Non choisi", tone: r.destination_calendar_id ? undefined : ("warn" as const) },
      { label: "Agendas vérifiés", value: ((r.check_calendar_ids as string[]) ?? []).map((id) => name(id)).join(", ") || "Aucun" },
      { label: "Google Meet", value: (meet.count ?? 0) > 0 ? `Activé sur ${meet.count} type(s) de rendez-vous` : "Activé sur aucun type de rendez-vous" },
      { label: "Rendez-vous à répercuter dans Google", value: out ? String(out) : "Aucun", tone: out ? ("warn" as const) : ("ok" as const) },
    ] : [{ label: "Identifiants Google et secret serveur", value: configured ? "Présents" : "Absents (GOOGLE_CALENDAR_CLIENT_ID / SECRET, APPOINTMENTS_SECRET)", tone: configured ? ("ok" as const) : ("warn" as const) }],
    disconnect: r ? { label: "Déconnecter Google Agenda", effect: "La réservation en ligne est suspendue (disponibilités invérifiables), ainsi que les reports par l'invité. Plus de création d'événements ni de liens Meet. Les événements déjà créés restent dans Google ; une annulation faite entre-temps y sera répercutée à la reconnexion. Les rendez-vous restent dans le CRM." } : null,
    external: "Le projet Google Cloud (API Calendar, URI de redirection) et les variables Vercel se gèrent hors du CRM.",
    account: r ? (r.google_email as string) ?? "Compte Google" : null,
    lastSuccess: dated(r?.events_synced_at as string, "Dernière lecture des changements Google"),
  };
  if (!r) return { ...base, state: "not_connected", problem: null, note: configured ? null : "Identifiants Google absents du serveur.", primary: configured ? { kind: "link", label: "Connecter", href: "/api/rendez-vous/google/connect" } : { kind: "manage", label: "Configurer" } };
  const err = (r.last_error as string) ?? "";
  if (r.status === "error") {
    const revoked = /invalid_grant|révoqu|401|unauthor/i.test(err);
    return { ...base, state: revoked ? "reconnect" : "sync_error", problem: { at: (r.updated_at as string) ?? null, message: revoked ? "Google a refusé l'accès (révoqué ou expiré)." : readable(err) }, note: null,
      primary: revoked ? { kind: "link", label: "Reconnecter", href: base.reconnectHref ?? "/parametres/connecteurs/google-agenda" } : { kind: "verify", label: "Vérifier" } };
  }
  if (r.events_sync_error || out > 0) {
    return { ...base, state: "sync_error", problem: { at: (r.updated_at as string) ?? null, message: out > 0 ? `${out} rendez-vous pas encore répercuté(s) dans Google.` : readable(String(r.events_sync_error)) }, note: null, primary: { kind: "manage", label: "Gérer" } };
  }
  if (check && !check.ok && newer(check.at, r.events_synced_at as string)) {
    return { ...base, state: "sync_error", problem: { at: check.at, message: check.message ?? "Dernière vérification en échec." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  }
  return { ...base, state: "connected", problem: null, note: null, primary: { kind: "manage", label: "Gérer" } };
}

/** Messages techniques → phrase courte, sans détail sensible. */
function readable(e: string) {
  if (!e) return "Erreur inconnue.";
  if (/injoignable|timeout|abort|network/i.test(e)) return "Google n'a pas répondu.";
  if (/quota|rate|429/i.test(e)) return "Quota Google atteint : nouvel essai plus tard.";
  return e.length > 160 ? `${e.slice(0, 157)}…` : e;
}

// ---------------------------------------------------------------------------
// Fireflies
// ---------------------------------------------------------------------------

const FF = {
  key: "fireflies" as const, name: "Fireflies", usage: "Historique des appels",
  feeds: ["Appels importés automatiquement (résumé, points clés, prochaines actions, transcription)", "Rattachement des appels aux fiches et aux rendez-vous", "Activité « Appel enregistré » sur la fiche"],
  links: [{ label: "Ouvrir le suivi Fireflies", href: "/appels/suivi" }, { label: "Appels à rattacher", href: "/appels" }],
};

async function fireflies(sb: SupabaseClient, c: Checks): Promise<Connector> {
  const [conn, failed, pending] = await Promise.all([
    sb.from("fireflies_connection").select("account_email, last_webhook_at, last_success_at, last_sync_at, last_error_code, last_error_at, api_paused_until").maybeSingle(),
    sb.from("fireflies_import_overview").select("job_id", { count: "exact", head: true }).eq("job_status", "failed"),
    sb.from("fireflies_import_overview").select("job_id", { count: "exact", head: true }).in("job_status", ["pending", "running"]),
  ]);
  if (conn.error) return unknown(FF, "Lecture de l'état Fireflies impossible.");
  const r = (conn.data ?? {}) as Row;
  const key = !!firefliesApiKey();
  const cfg = { key, webhook: !!firefliesWebhookSecret(), server: !!appointmentsSecretOrNull(), cron: (process.env.CRON_SECRET ?? "").length >= 16 };
  const missing = [!cfg.webhook && "secret du webhook", !cfg.server && "secret serveur", !cfg.cron && "passage quotidien"].filter(Boolean) as string[];
  const check = c.fireflies ?? null;
  const lastOk = (r.last_success_at as string) ?? null;
  const errCode = (r.last_error_code as string) ?? null;
  const errAt = (r.last_error_at as string) ?? null;
  const nFailed = failed.count ?? 0;
  const paused = r.api_paused_until && Date.parse(r.api_paused_until as string) > Date.now() ? (r.api_paused_until as string) : null;
  const base = {
    ...FF, lastCheck: check, canVerify: key,
    reconnectHref: null,
    account: (r.account_email as string) ?? null,
    permissions: ["Lecture des transcriptions et résumés du compte Fireflies (clé API)", "Réception des notifications de fin de transcription (webhook signé)"],
    settings: [
      { label: "Clé API", value: cfg.key ? "Présente" : "Absente (FIREFLIES_API_KEY)", tone: cfg.key ? ("ok" as const) : ("warn" as const) },
      { label: "Secret du webhook", value: cfg.webhook ? "Présent" : "Absent (FIREFLIES_WEBHOOK_SECRET)", tone: cfg.webhook ? ("ok" as const) : ("warn" as const) },
      { label: "Secret serveur", value: cfg.server ? "Présent" : "Absent (APPOINTMENTS_SECRET)", tone: cfg.server ? ("ok" as const) : ("warn" as const) },
      { label: "Passage quotidien", value: cfg.cron ? "Configuré (CRON_SECRET)" : "Absent (CRON_SECRET)", tone: cfg.cron ? ("ok" as const) : ("warn" as const) },
      { label: "Dernier webhook reçu", value: r.last_webhook_at ? fmtTime(r.last_webhook_at as string) : "Jamais", tone: "muted" as const },
      { label: "Imports en attente", value: String(pending.count ?? 0), tone: "muted" as const },
      { label: "Imports en échec", value: String(nFailed), tone: nFailed ? ("warn" as const) : ("ok" as const) },
    ],
    disconnect: null,
    external: "La clé API et le webhook se règlent dans Fireflies (Integrations › API, Webhooks V2) et les variables dans Vercel. Pour couper l'import, retirez FIREFLIES_API_KEY dans Vercel ; les appels déjà importés restent dans l'historique.",
    lastSuccess: dated(lastOk, "Dernier import"),
  };
  if (!key) return { ...base, state: "not_connected", problem: null, note: "Clé API absente du serveur.", primary: { kind: "manage", label: "Configurer" } };
  if (errCode === "auth" && newer(errAt, lastOk)) return { ...base, state: "reconnect", problem: { at: errAt, message: "Clé API refusée par Fireflies : remplacez FIREFLIES_API_KEY." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  if (check && !check.ok && newer(check.at, lastOk)) {
    return { ...base, state: /refus/i.test(check.message ?? "") ? "reconnect" : "sync_error", problem: { at: check.at, message: check.message ?? "Dernière vérification en échec." }, note: null, primary: { kind: "verify", label: "Vérifier" } };
  }
  if (paused || nFailed > 0 || (errCode && newer(errAt, lastOk))) {
    const message = paused ? `Quota Fireflies atteint : reprise après ${fmtTime(paused)}.` : nFailed ? `${nFailed} import(s) en échec.` : "Le dernier import a échoué.";
    return { ...base, state: "sync_error", problem: { at: errAt, message }, note: null, primary: { kind: "link", label: "Voir le suivi", href: "/appels/suivi" } };
  }
  if (missing.length) return { ...base, state: "to_verify", problem: null, note: `Configuration incomplète : ${missing.join(", ")}.`, primary: { kind: "manage", label: "Gérer" } };
  if (!lastOk && !(check?.ok)) return { ...base, state: "to_verify", problem: null, note: "Clé présente, jamais vérifiée ni utilisée.", primary: { kind: "verify", label: "Vérifier" } };
  return { ...base, state: "connected", problem: null, note: null, primary: { kind: "manage", label: "Gérer" } };
}

const fmtTime = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

// ---------------------------------------------------------------------------
// Claude / MCP Cely CRM
// ---------------------------------------------------------------------------

const MCP = {
  key: "claude_mcp" as const, name: "Claude · MCP Cely CRM", usage: "Accès au CRM depuis Claude",
  feeds: ["Recherche et lecture des fiches, pipelines, relances", "Création de fiches, contacts, tâches et notes d'échange (journalisées, sans fusion ni suppression)", "Dossiers de diagnostic ouverts depuis une fiche (emails et appels lisibles pour cette seule fiche)"],
  links: [{ label: "Bibliothèque de diagnostic", href: "/parametres/diagnostic" }],
};

/** Accès accordés par le propriétaire (Supabase Auth, serveur OAuth 2.1), avec délai maximal. */
export async function listMcpGrants(sb: SupabaseClient, timeoutMs = 5000): Promise<{ grants: McpGrant[] | null; error: string | null }> {
  try {
    const res = await Promise.race([
      sb.auth.oauth.listGrants(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    if (res.error) return { grants: null, error: "Le serveur d'autorisation n'a pas fourni la liste des accès." };
    return {
      grants: (res.data ?? []).map((g) => ({
        clientId: g.client.id, name: g.client.name || "Client sans nom", scopes: g.scopes ?? [], grantedAt: g.granted_at ?? null,
      })),
      error: null,
    };
  } catch {
    return { grants: null, error: "Le serveur d'autorisation ne répond pas." };
  }
}

async function claude(sb: SupabaseClient, c: Checks, mcpUrl: string): Promise<Connector> {
  const [{ grants, error }, last] = await Promise.all([
    listMcpGrants(sb, 1500), // court à l'ouverture : la page n'attend jamais un serveur lent
    sb.from("activity_log").select("created_at").eq("actor", "claude").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const lastWrite = (last.data?.created_at as string | undefined) ?? null;
  const names = new Set((grants ?? []).map((g) => g.name));
  const base = {
    ...MCP, lastCheck: c.claude_mcp ?? null, canVerify: true, reconnectHref: null, disconnect: null,
    account: grants?.length ? [...names].join(", ") : null,
    permissions: ["Vos propres droits sur le CRM (même compte, mêmes règles)", "Ni fusion, ni suppression, ni modification de masse ; aucun envoi aux prospects"],
    settings: [],
    external: "L'ajout du connecteur et le choix de ses outils se font dans Claude (Paramètres › Connecteurs). Les autres outils de Claude (Ubersuggest…) n'ont pas d'accès au CRM.",
    lastSuccess: dated(lastWrite, "Dernière écriture de Claude"),
    mcp: { url: mcpUrl, auth: "OAuth 2.1 (Supabase Auth) au nom de votre compte propriétaire ; un jeton sans autorisation OAuth est refusé.", grants, grantsError: error, lastWrite, shared: (grants?.length ?? 0) === 1 },
  };
  if (!grants) return { ...base, state: "unknown", problem: { at: null, message: error ?? "Liste des accès indisponible." }, note: "Le serveur MCP est en place ; les accès accordés ne peuvent pas être listés.", primary: { kind: "verify", label: "Vérifier" } };
  if (!grants.length) return { ...base, state: "not_connected", problem: null, note: "Aucun accès accordé à Claude.", primary: { kind: "manage", label: "Connecter" } };
  // K14 : seul ce que le serveur vérifie est affiché — un accès accordé, pas la preuve que Claude l'utilise
  return { ...base, state: "connected", problem: null, note: `${grants.length > 1 ? `${grants.length} accès accordés` : "Accès accordé"} ; l'usage réel se voit à la dernière écriture de Claude`, primary: { kind: "manage", label: "Gérer" } };
}

// ---------------------------------------------------------------------------
// Ubersuggest : utilisé depuis Claude, aucune connexion au CRM
// ---------------------------------------------------------------------------

function ubersuggest(): Connector {
  return {
    key: "ubersuggest", name: "Ubersuggest", usage: "Diagnostics SEO depuis Claude", state: "claude", account: null, lastSuccess: null, problem: null,
    note: "Connecté à Claude, pas au CRM : aucune donnée du CRM n'y est envoyée.", primary: { kind: "manage", label: "Détails" }, lastCheck: null,
    feeds: ["Rien dans le CRM : les résultats restent dans vos conversations Claude, sauf si vous les enregistrez vous-même sur une fiche"],
    permissions: [], settings: [], links: [], canVerify: false, reconnectHref: null, disconnect: null,
    external: "Se connecte, se vérifie et se retire dans Claude (Paramètres › Connecteurs). Le CRM ne peut pas voir son état.",
  };
}

export async function loadConnectors(sb: SupabaseClient, mcpUrl: string): Promise<Connector[]> {
  const c = await checks(sb).catch(() => ({}) as Checks);
  const safe = (p: Promise<Connector>, base: Pick<Connector, "key" | "name" | "usage" | "feeds" | "links">) => p.catch(() => unknown(base, "État illisible pour le moment."));
  return Promise.all([
    safe(gmail(sb, c), GMAIL),
    safe(calendar(sb, c), GCAL),
    safe(fireflies(sb, c), FF),
    safe(claude(sb, c, mcpUrl), MCP),
    Promise.resolve(ubersuggest()),
  ]);
}
