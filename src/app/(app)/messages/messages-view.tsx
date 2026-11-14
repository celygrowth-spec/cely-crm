"use client";

// Messages : s'ouvre sur une grille des clients actifs (pastille rouge = nouvelles réponses). Dans un client : à gauche
// ses conversations (la plus récente en haut), à droite le fil complet, lu chez lemlist à l'ouverture. Actualisation automatique toutes les 2 minutes tant que la page est
// visible (chaque compte au plus une fois par minute), et bouton « Actualiser ». Un compte en erreur est signalé
// sans masquer les autres.
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Mail, RefreshCw, Send } from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, Select, Spinner, Textarea, cn } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import type { InboxClient, InboxConversation, InboxData, MessageChannel, ReplyResult, SyncResult, ThreadMessage, ThreadView } from "@/lib/lemlist/types";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const INBOX = ["lemlist-inbox"];
const inboxKey = (client: string | null) => ["lemlist-inbox", client ?? "all"];
const AUTO_REFRESH_MS = 120_000;

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Le serveur n'a pas répondu. Vérifiez votre connexion.");
  }
  const r = (await res.json().catch(() => null)) as Result<T> | null;
  if (!r) throw new Error("Réponse illisible du serveur.");
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const CHANNEL_LABEL: Record<MessageChannel, string> = { email: "Email", linkedin: "LinkedIn" };
// pas d'icône de marque dans la bibliothèque : « in » sobre pour LinkedIn
const ChannelIcon = ({ c, size = 13 }: { c: MessageChannel; size?: number }) =>
  c === "linkedin" ? (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-[3px] bg-current font-bold leading-none" style={{ width: size, height: size, fontSize: size * 0.62 }}>
      <span className="text-white">in</span>
    </span>
  ) : <Mail size={size} aria-hidden />;
const contactLabel = (c: { contact_name: string | null; contact_email: string | null }) => c.contact_name || c.contact_email || "Contact sans nom";
const mainChannel = (c: InboxConversation): MessageChannel => c.last_channel ?? c.channels[0] ?? "email";

const when = (iso: string) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" });
  if (day.format(d) === day.format(new Date())) return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(d);
  return day.format(d);
};
const full = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

export function MessagesView({ client, conversation }: { client: string | null; conversation: string | null }) {
  const qc = useQueryClient();
  const key = inboxKey(client);
  const inbox = useQuery({ queryKey: key, queryFn: ({ signal }) => apiGet<InboxData>(`/api/lemlist/inbox${client ? `?company=${client}` : ""}`, signal) });
  // actualisation chez lemlist : à l'ouverture puis toutes les 2 minutes, page visible seulement
  const sync = useQuery({
    queryKey: ["lemlist-sync", client],
    queryFn: async () => {
      const r = await post<{ results: SyncResult[]; inbox: InboxData }>("/api/lemlist/inbox", { force: false, company: client });
      qc.setQueryData(key, r.inbox);
      qc.invalidateQueries({ queryKey: ["counters"] }); // compteur du menu
      return r.results;
    },
    refetchInterval: AUTO_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [channel, setChannel] = useState<"" | MessageChannel>("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(conversation);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await post<{ results: SyncResult[]; inbox: InboxData }>("/api/lemlist/inbox", { force: true, company: client });
      qc.setQueryData(key, r.inbox);
      qc.invalidateQueries({ queryKey: INBOX, predicate: (q) => q.queryKey[1] !== key[1] }); // grille ou autres clients
      qc.invalidateQueries({ queryKey: ["counters"] }); // compteur du menu
      qc.setQueryData(["lemlist-sync", client], r.results);
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(failed.length === 1 ? `Compte de ${failed[0].company_name} non actualisé.` : `${failed.length} comptes non actualisés.`);
      else toast.success("Messages actualisés.");
      if (selected) qc.invalidateQueries({ queryKey: ["lemlist-thread", selected] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Actualisation impossible.");
    } finally {
      setRefreshing(false);
    }
  }

  const data = inbox.data;
  const list = useMemo(() => (data?.conversations ?? []).filter((c) =>
    (!client || c.company_id === client) && (!channel || c.channels.includes(channel)) && (!unreadOnly || c.unread)), [data, client, channel, unreadOnly]);
  // comptes à signaler : à reconnecter, ou dernière lecture en échec (résultat de l'actualisation ou état enregistré).
  // Sur la grille, un compte à reconnecter est indiqué sur sa case : seul l'échec de lecture fait un bandeau.
  const problems = useMemo(() => {
    const failed = new Map((sync.data ?? []).filter((r) => !r.ok && !r.skipped).map((r) => [r.account_id, r.message]));
    return (data?.accounts ?? []).flatMap((a) => {
      if (a.status === "needs_reconnect") return client ? [{ id: a.id, text: `Compte lemlist de ${a.company_name} à reconnecter : ses conversations ne sont plus actualisées.`, reconnect: true }] : [];
      const msg = failed.get(a.id) ?? (a.last_error && !sync.data?.some((r) => r.account_id === a.id && r.ok && !r.skipped) ? a.last_error : null);
      return msg ? [{ id: a.id, text: `Compte lemlist de ${a.company_name} : ${msg}`, reconnect: false }] : [];
    });
  }, [data, sync.data, client]);
  const current = data?.conversations.find((c) => c.id === selected) ?? null;
  const unreadCount = data?.conversations.filter((c) => c.unread).length ?? 0;
  const company = data?.clients.find((x) => x.company_id === client) ?? null;

  return (
    <div className="flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col md:h-[calc(100dvh-8rem)]">
      {client && (
        <Link href="/messages" className="mb-1 inline-flex w-fit items-center gap-1 text-sm font-semibold text-violet-strong hover:underline" data-all-clients>
          <ArrowLeft size={14} aria-hidden /> Tous les clients
        </Link>
      )}
      <PageHeader
        title={client ? company?.company_name ?? "Messages" : "Messages"}
        description={client ? "Conversations email et LinkedIn du compte lemlist de ce client." : "Vos clients actifs sur lemlist : ouvrez un client pour lire ses conversations."}
        actions={<Button size="sm" onClick={refresh} disabled={refreshing}>{refreshing ? <Spinner /> : <RefreshCw size={13} />} Actualiser</Button>}
      />
      {problems.length > 0 && (
        <ul className="mb-3 space-y-1" aria-label="Comptes à vérifier">
          {problems.map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">{p.text}</span>
              {p.reconnect && <Link href="/parametres/connecteurs" className="shrink-0 font-semibold underline">Reconnecter</Link>}
            </li>
          ))}
        </ul>
      )}
      {inbox.isPending ? (
        <div className="p-6"><Spinner /></div>
      ) : inbox.error || !data ? (
        <p className="rounded-2xl border border-line bg-white p-4 text-sm font-semibold text-danger">Lecture des messages impossible. Rechargez la page.</p>
      ) : !data.clients.length ? (
        <EmptyState title="Aucun client actif sur lemlist" description="Connectez le compte lemlist d'un client dans Paramètres › Connecteurs › lemlist clients."
          action={<Link href="/parametres/connecteurs" className="text-sm font-semibold text-violet-strong underline">Ouvrir Connecteurs</Link>} />
      ) : !client ? (
        <ClientGrid clients={data.clients} />
      ) : !company ? (
        <EmptyState title="Ce client n'a plus de compte lemlist actif" description="Son compte a pu être déconnecté."
          action={<Link href="/messages" className="text-sm font-semibold text-violet-strong underline">Tous les clients</Link>} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(280px,380px)_1fr]">
          <section aria-label="Conversations" className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white", selected && "hidden md:flex")}>
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
              <Select aria-label="Canal" value={channel} onChange={(e) => setChannel(e.target.value as "" | MessageChannel)} className="h-8 w-auto text-xs">
                <option value="">Tous canaux</option>
                <option value="email">Email</option>
                <option value="linkedin">LinkedIn</option>
              </Select>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Non lus{unreadCount ? ` (${unreadCount})` : ""}
              </label>
            </div>
            {!list.length ? (
              <p className="p-4 text-sm text-muted">{data.conversations.length ? "Aucune conversation pour ces filtres." : sync.isFetching ? "Lecture du compte lemlist…" : "Aucune conversation pour le moment."}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
                {list.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setSelected(c.id)} aria-current={c.id === selected ? "true" : undefined} data-conversation={c.id}
                      className={cn("flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface", c.id === selected && "bg-violet-soft")}>
                      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", c.unread ? "bg-violet" : "bg-transparent")} aria-label={c.unread ? "Non lu" : undefined} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("truncate text-sm", c.unread ? "font-bold text-ink" : "font-semibold text-ink")}>{contactLabel(c)}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted">{when(c.last_activity_at)}</span>
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          <ChannelIcon c={mainChannel(c)} />
                          <span>{c.channels.map((x) => CHANNEL_LABEL[x]).join(" · ")}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Fil de la conversation" className={cn("min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white", selected ? "flex" : "hidden md:flex")}>
            {current ? <Thread key={current.id} c={current} onBack={() => setSelected(null)} />
              : <p className="m-auto p-6 text-sm text-muted">Choisissez une conversation pour lire le fil.</p>}
          </section>
        </div>
      )}
    </div>
  );
}

/** Grille des clients actifs : ceux qui ont de nouvelles réponses d'abord (ordre calculé par la base). */
function ClientGrid({ clients }: { clients: InboxClient[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Clients">
      {clients.map((x) => (
        <li key={x.company_id}>
          <Link href={`/messages?client=${x.company_id}`} data-client={x.company_id}
            className={cn("flex h-full items-start gap-3 rounded-2xl border bg-white p-4 hover:border-violet", x.unread ? "border-red-200" : "border-line")}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-ink">{x.company_name}</span>
              <span className="mt-1 block text-xs text-muted">
                {x.last_reply_at ? `Dernière réponse : ${when(x.last_reply_at)}` : x.last_activity_at ? "Aucune réponse reçue" : "Aucune conversation"}
              </span>
              {x.status === "needs_reconnect" && (
                <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900" data-client-reconnect>
                  <AlertTriangle size={11} aria-hidden /> À reconnecter
                </span>
              )}
            </span>
            {x.unread > 0 && (
              <span className="shrink-0 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white" data-client-unread={x.unread}
                aria-label={`${x.unread} nouvelle(s) réponse(s)`}>{x.unread}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Thread({ c, onBack }: { c: InboxConversation; onBack: () => void }) {
  const qc = useQueryClient();
  // réponses envoyées depuis le CRM, affichées tant que lemlist ne les renvoie pas encore dans le fil
  const [local, setLocal] = useState<ThreadMessage[]>([]);
  const t = useQuery({
    queryKey: ["lemlist-thread", c.id],
    queryFn: async () => {
      const v = await post<ThreadView>(`/api/lemlist/conversations/${c.id}`, { op: "open" });
      // ouverte dans le CRM : n'est plus « non lue » ici (rien n'est changé chez lemlist)
      if (v.ok) {
        // tout de suite à l'écran (liste et pastille du client), puis relu au CRM (grille comprise)
        qc.setQueriesData<InboxData>({ queryKey: INBOX }, (d) => d && {
          ...d,
          conversations: d.conversations.map((x) => (x.id === c.id ? { ...x, unread: false } : x)),
          clients: d.clients.map((x) => (x.company_id === c.company_id && c.unread ? { ...x, unread: Math.max(0, x.unread - 1) } : x)),
        });
        qc.invalidateQueries({ queryKey: INBOX });
        qc.invalidateQueries({ queryKey: ["counters"] });
      }
      return v;
    },
    staleTime: 0,
    retry: false,
  });
  const norm = (x: string) => x.replace(/\s+/g, " ").trim();
  const pendingShown = local.filter((m) => !t.data?.messages.some((x) => x.direction === "out" && x.channel === m.channel && norm(x.text) === norm(m.text)));
  return (
    <>
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} className="mt-0.5 text-muted hover:text-ink md:hidden" aria-label="Retour à la liste"><ArrowLeft size={18} /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">{contactLabel(c)}</p>
          <p className="truncate text-xs text-muted">{[c.contact_name && c.contact_email, `Client : ${c.company_name}`].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex shrink-0 gap-1">{c.channels.map((x) => <Badge key={x}><ChannelIcon c={x} size={11} />{CHANNEL_LABEL[x]}</Badge>)}</div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface/40 p-4">
        {t.isPending ? <Spinner /> : t.error ? (
          <p className="text-sm font-semibold text-danger">{t.error.message}</p>
        ) : !t.data.ok ? (
          <p className="text-sm font-semibold text-danger">{t.data.error}</p>
        ) : !t.data.messages.length && !pendingShown.length ? (
          <p className="text-sm text-muted">Aucun message email ou LinkedIn dans ce fil.</p>
        ) : [...t.data.messages, ...pendingShown].map((m) => (
          <article key={m.id} className={cn("max-w-[85%] rounded-2xl border px-3 py-2 text-sm", m.direction === "in" ? "border-line bg-white" : "ml-auto border-violet/30 bg-violet-soft")} data-direction={m.direction}>
            <p className="mb-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
              <ChannelIcon c={m.channel} size={11} />
              <span className="font-semibold">{m.direction === "in" ? contactLabel(c) : m.sender_name || m.sender_email || "Expéditeur du client"}</span>
              <time dateTime={m.at}>{full(m.at)}</time>
            </p>
            {m.subject && <p className="mb-1 font-semibold text-ink">{m.subject}</p>}
            <p className="whitespace-pre-wrap break-words text-ink">{m.text || "(message vide)"}</p>
            {m.id.startsWith("local-") && <p className="mt-1 text-[11px] text-muted">Envoyé depuis le CRM · apparaîtra dans lemlist au prochain rafraîchissement</p>}
          </article>
        ))}
      </div>
      {t.data?.ok && <Composer c={c} view={t.data} onSent={(m) => { setLocal((l) => [...l, m]); qc.invalidateQueries({ queryKey: ["lemlist-thread", c.id] }); }} />}
    </>
  );
}

// brouillons par conversation, gardés tant que la page est ouverte (changer de conversation ne perd rien)
const drafts = new Map<string, string>();

function Composer({ c, view, onSent }: { c: InboxConversation; view: ThreadView; onSent: (m: ThreadMessage) => void }) {
  const available = c.channels.filter((x) => (x === "email" ? view.reply_from.email : view.reply_from.linkedin));
  const [channel, setChannel] = useState<MessageChannel>(available.includes(mainChannel(c)) ? mainChannel(c) : available[0] ?? mainChannel(c));
  const [text, setTextState] = useState(() => drafts.get(c.id) ?? "");
  const setText = (v: string) => { drafts.set(c.id, v); setTextState(v); };
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ kind: "failed" | "uncertain"; message: string } | null>(null);
  // une clé par tentative : un double clic ou une requête rejouée ne part qu'une fois
  const attempt = useRef<string | null>(null);
  const from = channel === "email" ? view.reply_from.email : view.reply_from.linkedin;
  const sender = channel === "email" && view.reply_from.email
    ? [view.reply_from.email.name, view.reply_from.email.email].filter(Boolean).join(" · ")
    : view.reply_from.linkedin?.name || "membre de l'équipe qui suit la conversation";

  async function send(again = false) {
    if (sending || !text.trim() || !from) return;
    if (!attempt.current || again) attempt.current = crypto.randomUUID();
    setSending(true);
    setProblem(null);
    try {
      const r = await post<ReplyResult>(`/api/lemlist/conversations/${c.id}`, { op: "reply", channel, text, key: attempt.current });
      if (r.status === "sent") {
        onSent({ id: `local-${attempt.current}`, channel, direction: "out", at: new Date().toISOString(), subject: null, text: text.trim(), sender_name: channel === "email" ? view.reply_from.email?.name ?? null : view.reply_from.linkedin?.name ?? null, sender_email: channel === "email" ? view.reply_from.email?.email ?? null : null });
        attempt.current = null;
        setText("");
        toast.success(r.duplicate ? "Cette réponse était déjà partie." : "Réponse envoyée.");
      } else if (r.status === "uncertain") {
        setProblem({ kind: "uncertain", message: r.message ?? "Envoi incertain : actualisez le fil pour vérifier avant de renvoyer." });
      } else {
        attempt.current = null; // échec certain : la prochaine tentative est un nouvel envoi
        setProblem({ kind: "failed", message: r.message ?? "La réponse n'est pas partie." });
      }
    } catch (e) {
      // réponse du serveur perdue : on ne sait pas si l'envoi est parti, la même clé protège d'un double envoi
      setProblem({ kind: "uncertain", message: e instanceof Error ? `${e.message} Réessayer renvoie la même demande : elle ne partira qu'une fois.` : "Résultat inconnu." });
    } finally {
      setSending(false);
    }
  }

  if (!available.length) {
    return <p className="border-t border-line px-4 py-3 text-xs text-muted">Réponse impossible depuis le CRM : l&apos;expéditeur de cette conversation n&apos;apparaît pas dans le fil. Répondez depuis lemlist.</p>;
  }
  return (
    <form className="space-y-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p className="flex-1 text-muted" data-reply-from>
          Envoi depuis : <span className="font-semibold text-ink">compte lemlist de {view.company_name}</span>
          {view.team_name ? ` (${view.team_name})` : ""}, <span className="font-semibold text-ink">{sender}</span>
          {" "}· par {CHANNEL_LABEL[channel]}
        </p>
        {available.length > 1 && (
          <Select aria-label="Canal de la réponse" value={channel} onChange={(e) => { setChannel(e.target.value as MessageChannel); setProblem(null); attempt.current = null; }} className="h-7 w-auto text-xs">
            {available.map((x) => <option key={x} value={x}>{CHANNEL_LABEL[x]}</option>)}
          </Select>
        )}
      </div>
      <Textarea aria-label="Votre réponse" rows={3} value={text} disabled={sending} maxLength={5000}
        onChange={(e) => { setText(e.target.value); if (problem?.kind === "failed") setProblem(null); }}
        placeholder={`Répondre à ${contactLabel(c)}…`} />
      {problem && (
        <p role="alert" className={cn("text-xs font-semibold", problem.kind === "failed" ? "text-danger" : "text-amber-800")}>{problem.message}</p>
      )}
      <div className="flex justify-end gap-2">
        {problem?.kind === "uncertain" && (
          <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => { if (confirm("Renvoyer quand même ? Si la première réponse est partie, le contact la recevra deux fois.")) void send(true); }}>Renvoyer quand même</Button>
        )}
        <Button type="submit" size="sm" variant="primary" disabled={sending || !text.trim()}>{sending ? <Spinner /> : <Send size={13} />} Envoyer</Button>
      </div>
    </form>
  );
}
