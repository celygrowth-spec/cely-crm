"use client";

import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertCircle, Archive, ArchiveRestore, ArrowLeft, Check, File, FileText, Flag, Folder, FolderInput, ImageOff, Inbox, Mail, MailOpen, OctagonAlert, Paperclip, Pencil, RefreshCw, Reply, ReplyAll, Forward, Search, Building2, CalendarClock, UserPlus, Send, ShieldCheck, Star, Tag, Tags, Trash2, X } from "lucide-react";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, EmptyState, Input, Select, Skeleton, cn } from "@/components/ui";
import { mailCall } from "@/lib/client/mail";
import { apiGet } from "@/lib/client/query";
import { PROSPECT_STATUS_LABELS, TZ, formatDate } from "@/lib/format";
import { CATEGORY_FOLDERS, SYSTEM_FOLDERS, applyBoxAction, inFolder, type BoxAction, type BoxActionResult, type BoxCrmMatch, type BoxFolder, type BoxOpenMessage, type BoxOpenThread, type BoxThread, type BoxThreadPage } from "@/lib/mail/box-types";
import { BOX_TONE } from "../box-status";
import { BOX_KEY, useBoxSync } from "../use-box-sync";
import { Composer, type ComposeRequest } from "./composer";

const ICONS: Record<string, typeof Inbox> = { INBOX: Inbox, STARRED: Star, IMPORTANT: Flag, SENT: Send, DRAFT: FileText, ALL: Archive, SPAM: OctagonAlert, TRASH: Trash2 };
/** Dossiers dont le compteur est le total (et non les non-lus), comme dans Gmail. */
const COUNT_TOTAL = new Set(["DRAFT"]);
const NO_COUNT = new Set(["SENT", "ALL", "TRASH", "STARRED", "IMPORTANT"]);

const day = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hour = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const short = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric", month: "short" });
const long = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const full = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Comme une boîte mail : l'heure aujourd'hui, le jour cette année, la date complète avant. */
function listDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (day.format(d) === day.format(now)) return hour.format(d);
  return day.format(d).slice(0, 4) === day.format(now).slice(0, 4) ? short.format(d) : long.format(d);
}
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

type FolderItem = { id: string; label: string; count: number; user: boolean };

function useFolders() {
  const q = useQuery({ queryKey: [...BOX_KEY, "folders"], queryFn: ({ signal }) => apiGet<BoxFolder[]>("/api/mail/box/folders", signal) });
  const items = useMemo(() => {
    const by = new Map((q.data ?? []).map((f) => [f.id, f]));
    const count = (id: string) => {
      const f = by.get(id);
      return !f || NO_COUNT.has(id) ? 0 : COUNT_TOTAL.has(id) ? f.total : f.unread;
    };
    const system: FolderItem[] = SYSTEM_FOLDERS.map((f) => ({ id: f.id, label: f.label, count: count(f.id), user: false }));
    const categories: FolderItem[] = CATEGORY_FOLDERS.filter((f) => by.has(f.id)).map((f) => ({ id: f.id, label: f.label, count: count(f.id), user: false }));
    const labels: FolderItem[] = (q.data ?? []).filter((f) => f.kind === "user").sort((a, b) => a.name.localeCompare(b.name, "fr"))
      .map((f) => ({ id: f.id, label: f.name, count: f.unread, user: true }));
    return { system, categories, labels };
  }, [q.data]);
  return { ...items, loading: q.isLoading };
}

type ActionExtra = { label_id?: string; from_label?: string };
type Act = (action: BoxAction, ids: string[], extra?: ActionExtra) => Promise<boolean>;
type ListKey = { label?: string; q?: string };
const FAMILY: Record<BoxAction, string> = {
  archive: "archive", trash: "trash", untrash: "trash", read: "read", unread: "read", star: "star", unstar: "star",
  important: "important", unimportant: "important", spam: "spam", unspam: "spam", label: "label", unlabel: "label", move: "move",
};

/**
 * Tri : l'écran est mis à jour tout de suite, l'action part vers Gmail, et l'écran revient en arrière si Gmail
 * refuse. Une action déjà en cours sur les mêmes fils n'est pas renvoyée (double clic).
 */
function useBoxActions(sync: () => Promise<unknown>): { act: Act; busy: boolean } {
  const qc = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState(0);
  const act = useCallback<Act>(async (action, ids, extra = {}) => {
    // même famille d'action sur les mêmes fils : un second clic (qui verrait le bouton déjà inversé) est ignoré
    const key = `${FAMILY[action]}:${extra.label_id ?? ""}:${[...ids].sort().join(",")}`;
    if (!ids.length || inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setBusy((n) => n + 1);
    const lists = [...BOX_KEY, "threads"];
    await qc.cancelQueries({ queryKey: lists });
    const before = qc.getQueriesData<InfiniteData<BoxThreadPage>>({ queryKey: lists });
    const touched = new Set(ids);
    for (const [k, data] of before) {
      if (!data) continue;
      const folder = (k[2] as ListKey | undefined)?.label;
      qc.setQueryData<InfiniteData<BoxThreadPage>>(k, {
        ...data,
        pages: data.pages.map((pg) => ({
          ...pg,
          threads: pg.threads.flatMap((t) => {
            if (!touched.has(t.thread_id)) return [t];
            const label_ids = applyBoxAction(t.label_ids, action, extra);
            // dans un dossier, le fil qui n'y est plus disparaît ; dans une recherche, il reste affiché
            if (folder && !inFolder(label_ids, folder)) return [];
            return [{ ...t, label_ids, unread: label_ids.includes("UNREAD"), starred: label_ids.includes("STARRED"), important: label_ids.includes("IMPORTANT") }];
          }),
        })),
      });
    }
    let ok = true;
    try {
      let missing = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const r = await mailCall<BoxActionResult>("/api/mail/box/actions", "POST", { action, thread_ids: ids.slice(i, i + 50), ...extra });
        if (!r.ok) throw new Error(r.error);
        missing += r.data.failed.length;
      }
      if (missing) toast.message(`${missing} fil${missing > 1 ? "s n'existent" : " n'existe"} plus dans Gmail.`);
    } catch (e) {
      ok = false;
      for (const [k, data] of before) qc.setQueryData(k, data); // retour en arrière : Gmail n'a pas appliqué l'action
      toast.error(e instanceof Error && e.message ? e.message : "Gmail n'a pas appliqué l'action. Réessayez.");
    } finally {
      inFlight.current.delete(key);
      setBusy((n) => n - 1);
      // compteurs et état réel : repris de Gmail
      await sync();
      void qc.invalidateQueries({ queryKey: BOX_KEY });
    }
    return ok;
  }, [qc, sync]);
  return { act, busy: busy > 0 };
}

export function Mailbox() {
  const { status, syncing, run } = useBoxSync();
  const folders = useFolders();
  const [label, setLabel] = useState("INBOX");
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { act } = useBoxActions(run);
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const [composeKey, setComposeKey] = useState(0);
  const write = useCallback((r: ComposeRequest) => { setCompose(r); setComposeKey((k) => k + 1); }, []);
  const refresh = useCallback(() => { void run(); }, [run]);

  const list = useInfiniteQuery({
    queryKey: [...BOX_KEY, "threads", query ? { q: query } : { label }],
    queryFn: ({ pageParam, signal }) =>
      apiGet<BoxThreadPage>(`/api/mail/box/threads?${new URLSearchParams({ ...(query ? { q: query } : { label }), ...(pageParam ? { page: pageParam } : {}) })}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: !!status && status.state !== "none",
  });
  const threads = useMemo(() => list.data?.pages.flatMap((p) => p.threads) ?? [], [list.data]);

  const pick = (id: string) => {
    setLabel(id);
    setQuery("");
    setTyped("");
    setOpenId(null);
    setSelected(new Set());
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQuery(typed.trim());
    setOpenId(null);
    setSelected(new Set());
  };
  const all = [...folders.system, ...folders.categories, ...folders.labels];
  const context = query ? null : label;
  const chosen = threads.filter((t) => selected.has(t.thread_id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** Après une action qui sort les fils du dossier affiché : la sélection et le fil ouvert n'ont plus lieu d'être. */
  const after = (ids: string[]) => {
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    if (openId && ids.includes(openId)) setOpenId(null);
  };
  const title = query ? `Recherche : ${query}` : (all.find((f) => f.id === label)?.label ?? "Dossier");

  if (!status) return <Skeleton className="h-96 w-full" />;
  if (status.state === "none") {
    return <EmptyState title="Aucune boîte connectée" description="Connectez votre compte Gmail pour lire vos messages ici." action={<Link href="/mail" className="font-semibold text-violet-strong underline">Connecter Gmail</Link>} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={search} className="relative min-w-0 flex-1" role="search">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Rechercher dans la boîte (from:, to:, subject:, has:attachment, in:spam…)" aria-label="Rechercher dans la boîte" className="pr-9 pl-9" />
          {(typed || query) && (
            <button type="button" onClick={() => { setTyped(""); setQuery(""); }} aria-label="Effacer la recherche" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"><X size={14} /></button>
          )}
        </form>
        {status.can_modify && <Button variant="primary" onClick={() => write({ kind: "new" })}><Pencil size={14} /> <span className="hidden sm:inline">Nouveau message</span></Button>}
        <Badge tone={BOX_TONE[status.state].tone}>{BOX_TONE[status.state].label}</Badge>
        <Button variant="secondary" onClick={() => run()} disabled={syncing} aria-label="Synchroniser la boîte">
          <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} /> <span className="hidden sm:inline">{syncing ? "Synchronisation…" : "Synchroniser"}</span>
        </Button>
      </div>
      {status.state === "error" && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger"><AlertCircle size={16} className="mt-0.5 shrink-0" /> <span>{status.message} <Link href="/mail" className="font-semibold underline">Ouvrir « Compte et envois »</Link></span></p>
      )}
      {(status.state === "initial" || status.state === "pending") && (
        <p className="rounded-lg bg-violet-soft px-3 py-2 text-sm">{status.message} {status.messages.toLocaleString("fr-FR")} messages lus pour l&apos;instant : les plus anciens arrivent au fur et à mesure.</p>
      )}

      <div className="grid h-[calc(100dvh-17rem)] min-h-[30rem] overflow-hidden rounded-xl border border-line bg-white lg:grid-cols-[13rem_22rem_minmax(0,1fr)]">
        {/* Dossiers et libellés */}
        <nav aria-label="Dossiers" className="hidden overflow-y-auto border-r border-line p-2 lg:block">
          <FolderGroup items={folders.system} current={query ? null : label} onPick={pick} />
          {folders.categories.length > 0 && <FolderGroup title="Catégories" items={folders.categories} current={query ? null : label} onPick={pick} />}
          {folders.labels.length > 0 && <FolderGroup title="Libellés" items={folders.labels} current={query ? null : label} onPick={pick} />}
        </nav>

        {/* Liste des fils */}
        <section aria-label={title} className={cn("flex min-h-0 flex-col border-line lg:border-r", openId && "hidden lg:flex")}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Select value={query ? "" : label} onChange={(e) => pick(e.target.value)} aria-label="Dossier" className="lg:hidden">
              {query && <option value="">Recherche</option>}
              {all.map((f) => <option key={f.id} value={f.id}>{f.label}{f.count ? ` (${f.count})` : ""}</option>)}
            </Select>
            <h2 className="hidden min-w-0 flex-1 truncate font-display text-sm font-bold lg:block">{title}</h2>
          </div>
          {status.can_modify ? (
            <div className="flex min-h-10 flex-wrap items-center gap-1 border-b border-line px-3 py-1">
              <input type="checkbox" aria-label="Tout sélectionner" className="size-4 accent-violet" checked={threads.length > 0 && chosen.length === threads.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(threads.map((t) => t.thread_id)) : new Set())} />
              {chosen.length > 0
                ? <><span className="mr-1 text-xs font-semibold tabular-nums">{chosen.length}</span><ThreadActions threads={chosen} context={context} labels={folders.labels} act={act} onGone={after} /></>
                : <span className="text-xs text-muted">Cochez des messages pour les trier</span>}
            </div>
          ) : (
            <p className="border-b border-line bg-violet-soft px-3 py-1.5 text-xs">Lecture seule. Pour trier vos messages, <a className="font-semibold underline" href={`/api/mail/oauth/start${status.email ? `?hint=${encodeURIComponent(status.email)}` : ""}`}>reconnectez Gmail</a> en acceptant toutes les autorisations.</p>
          )}
          <ThreadList threads={threads} openId={openId} onOpen={setOpenId} selected={status.can_modify ? selected : null} onToggle={toggle} loading={list.isLoading} error={list.isError ? list.error.message : null} retry={() => list.refetch()}
            hasMore={!!list.hasNextPage} loadingMore={list.isFetchingNextPage} more={() => list.fetchNextPage()} empty={query ? "Aucun message ne correspond à cette recherche." : "Aucun message dans ce dossier."} />
        </section>

        {/* Fil ouvert */}
        <section aria-label="Message" className={cn("min-h-0 min-w-0 overflow-y-auto", !openId && "hidden lg:block")}>
          {openId ? <Reader key={openId} id={openId} onBack={() => setOpenId(null)} summary={threads.find((t) => t.thread_id === openId) ?? null} context={context} labels={folders.labels} act={status.can_modify ? act : null} onGone={after} onWrite={status.can_modify ? write : null} me={status.email} /> : <p className="p-8 text-center text-sm text-muted">Choisissez un message pour le lire.</p>}
        </section>
      </div>
      {compose && <Composer key={composeKey} request={compose} onClose={() => setCompose(null)} onChanged={refresh} />}
    </div>
  );
}

function FolderGroup({ title, items, current, onPick }: { title?: string; items: FolderItem[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <div className="mb-2">
      {title && <p className="px-2 pt-2 pb-1 font-label text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</p>}
      <ul>
        {items.map((f) => {
          const Icon = f.user ? Tag : (ICONS[f.id] ?? Folder);
          const active = current === f.id;
          return (
            <li key={f.id}>
              <button type="button" onClick={() => onPick(f.id)} aria-current={active ? "page" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", active ? "bg-violet-soft font-semibold text-ink" : "text-muted hover:bg-violet-soft/60 hover:text-ink")}>
                <Icon size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                {f.count > 0 && <span className="text-xs font-semibold text-ink tabular-nums" aria-label={`${f.count} ${COUNT_TOTAL.has(f.id) ? "éléments" : "non lus"}`}>{f.count.toLocaleString("fr-FR")}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ThreadList(p: { threads: BoxThread[]; openId: string | null; onOpen: (id: string) => void; selected: Set<string> | null; onToggle: (id: string) => void; loading: boolean; error: string | null; retry: () => void; hasMore: boolean; loadingMore: boolean; more: () => void; empty: string }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadingMore, more } = p;
  // page suivante chargée à l'approche du bas de la liste
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, more]);

  if (p.loading) return <div className="space-y-2 p-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (p.error) return <p className="p-4 text-sm text-danger">{p.error} <button type="button" className="underline" onClick={p.retry}>Réessayer</button></p>;
  if (!p.threads.length) return <p className="p-6 text-center text-sm text-muted">{p.empty}</p>;
  return (
    <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
      {p.threads.map((t) => (
        <li key={t.thread_id} className={cn("flex items-stretch hover:bg-violet-soft/60", (p.openId === t.thread_id || p.selected?.has(t.thread_id)) && "bg-violet-soft")}>
          {p.selected && (
            <label className="flex cursor-pointer items-start pt-3 pl-3">
              <input type="checkbox" className="size-4 accent-violet" checked={p.selected.has(t.thread_id)} onChange={() => p.onToggle(t.thread_id)} aria-label={`Sélectionner : ${t.subject || "(sans objet)"}`} />
            </label>
          )}
          <button type="button" onClick={() => p.onOpen(t.thread_id)} aria-current={p.openId === t.thread_id ? "true" : undefined}
            className={cn("block min-w-0 flex-1 px-3 py-2 text-left", t.unread ? "text-ink" : "text-muted")}>
            <div className="flex items-baseline gap-2">
              {t.unread && <span className="size-2 shrink-0 self-center rounded-full bg-violet" aria-label="Non lu" />}
              <span className={cn("min-w-0 flex-1 truncate text-sm", t.unread && "font-bold")}>
                {t.participants.join(", ") || "(expéditeur inconnu)"}{t.message_count > 1 && <span className="ml-1 text-xs font-normal text-muted">{t.message_count}</span>}
              </span>
              <span className={cn("shrink-0 text-xs tabular-nums", t.unread && "font-semibold")}>{listDate(t.last_at)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate text-sm", t.unread ? "font-semibold" : "text-ink")}>{t.subject || "(sans objet)"}</span>
              {t.has_attachments && <Paperclip size={12} className="shrink-0" aria-label="Pièce jointe" />}
              {t.important && <Flag size={12} className="shrink-0 text-violet-strong" aria-label="Important" />}
              {t.starred && <Star size={12} className="shrink-0 fill-current text-violet-strong" aria-label="Suivi" />}
            </div>
            <p className="truncate text-xs text-muted">{t.snippet}</p>
          </button>
        </li>
      ))}
      <li aria-hidden={!p.hasMore}>
        <div ref={sentinel} />
        {p.hasMore && <p className="p-3 text-center text-xs text-muted">{p.loadingMore ? "Chargement…" : <button type="button" className="underline" onClick={p.more}>Afficher la suite</button>}</p>}
      </li>
    </ul>
  );
}

function IconAction({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={active}
      className={cn("rounded-lg p-1.5 hover:bg-violet-soft hover:text-ink", active ? "text-violet-strong" : "text-muted")}>{children}</button>
  );
}

/** Menu déroulant simple : se ferme au choix, à Échap ou au clic ailleurs. */
function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} className="rounded-lg p-1.5 text-muted hover:bg-violet-soft hover:text-ink">{icon}</button>
      {open && <div role="menu" aria-label={label} className="absolute top-full left-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-lg">{children(() => setOpen(false))}</div>}
    </div>
  );
}
const MenuItem = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-violet-soft">{children}</button>
);

/**
 * Actions de tri sur un ou plusieurs fils. Chaque bouton vise un état (« marquer comme lu »), choisi d'après l'état
 * actuel des fils. `onGone` : fils qui quittent le dossier affiché.
 */
function ThreadActions({ threads, context, labels, act, onGone }: { threads: BoxThread[]; context: string | null; labels: FolderItem[]; act: Act; onGone: (ids: string[]) => void }) {
  const ids = threads.map((t) => t.thread_id);
  const leave = (action: BoxAction, extra?: ActionExtra) => { onGone(ids); void act(action, ids, extra); };
  const anyUnread = threads.some((t) => t.unread);
  const allStarred = threads.every((t) => t.starred);
  const allImportant = threads.every((t) => t.important);
  const inTrash = context === "TRASH";
  const inSpam = context === "SPAM";
  const has = (l: string) => threads.every((t) => t.label_ids.includes(l));
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Trier">
      {!inTrash && !inSpam && has("INBOX") && <IconAction label="Archiver" onClick={() => leave("archive")}><Archive size={16} /></IconAction>}
      {inTrash
        ? <IconAction label="Restaurer dans la boîte de réception" onClick={() => leave("untrash")}><ArchiveRestore size={16} /></IconAction>
        : <IconAction label="Supprimer (corbeille)" onClick={() => leave("trash")}><Trash2 size={16} /></IconAction>}
      {inSpam
        ? <IconAction label="Non-spam" onClick={() => leave("unspam")}><ShieldCheck size={16} /></IconAction>
        : !inTrash && <IconAction label="Signaler comme spam" onClick={() => leave("spam")}><OctagonAlert size={16} /></IconAction>}
      <IconAction label={anyUnread ? "Marquer comme lu" : "Marquer comme non lu"} onClick={() => void act(anyUnread ? "read" : "unread", ids)}>{anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}</IconAction>
      <IconAction label={allStarred ? "Retirer le suivi" : "Suivre"} active={allStarred} onClick={() => void act(allStarred ? "unstar" : "star", ids)}><Star size={16} className={allStarred ? "fill-current" : undefined} /></IconAction>
      <IconAction label={allImportant ? "Marquer comme non important" : "Marquer comme important"} active={allImportant} onClick={() => void act(allImportant ? "unimportant" : "important", ids)}><Flag size={16} className={allImportant ? "fill-current" : undefined} /></IconAction>
      <Menu label="Libellés" icon={<Tags size={16} />}>
        {(close) => labels.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted">Aucun libellé personnel dans Gmail.</p> : labels.map((l) => {
          const on = has(l.id);
          return <MenuItem key={l.id} onClick={() => { close(); if (on && context === l.id) onGone(ids); void act(on ? "unlabel" : "label", ids, { label_id: l.id }); }}><Check size={14} className={on ? "text-violet-strong" : "invisible"} /><span className="truncate">{l.label}</span></MenuItem>;
        })}
      </Menu>
      <Menu label="Déplacer vers" icon={<FolderInput size={16} />}>
        {(close) => [{ id: "INBOX", label: "Boîte de réception" }, ...labels].filter((l) => l.id !== context).map((l) => (
          <MenuItem key={l.id} onClick={() => { close(); if (context && context !== "ALL") onGone(ids); void act("move", ids, { label_id: l.id, ...(context ? { from_label: context } : {}) }); }}>
            {l.id === "INBOX" ? <Inbox size={14} /> : <Tag size={14} />}<span className="truncate">{l.label}</span>
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

function Reader({ id, onBack, summary, context, labels, act, onGone, onWrite, me }: { id: string; onBack: () => void; summary: BoxThread | null; context: string | null; labels: FolderItem[]; act: Act | null; onGone: (ids: string[]) => void; onWrite: ((r: ComposeRequest) => void) | null; me: string | null }) {
  const [images, setImages] = useState(false);
  const q = useQuery({
    queryKey: [...BOX_KEY, "thread", id, images],
    queryFn: ({ signal }) => apiGet<BoxOpenThread>(`/api/mail/box/threads/${encodeURIComponent(id)}${images ? "?images=1" : ""}`, signal),
    placeholderData: (previous) => previous,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // comme dans une boîte mail : ouvrir un fil non lu le marque comme lu (dans Gmail aussi)
  const unread = !!q.data?.messages.some((m) => m.label_ids.includes("UNREAD"));
  useEffect(() => {
    if (unread && act) void act("read", [id]);
  }, [unread, act, id]);
  if (q.isLoading) return <div className="space-y-3 p-5"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) return <p className="p-5 text-sm text-danger">{q.error?.message ?? "Lecture impossible"} <button type="button" className="underline" onClick={() => q.refetch()}>Réessayer</button> · <button type="button" className="underline" onClick={onBack}>Retour</button></p>;
  const t = q.data;
  const lastId = t.messages.at(-1)?.id;
  const hidden = !images && t.messages.some((m) => m.remote_images);
  // correspondants du fil (hors ma propre adresse) : ils déterminent la fiche affichée à côté
  const mine = me?.toLowerCase() ?? "";
  const others = [...new Set(t.messages.flatMap((m) => [m.from_email ?? "", ...m.to_list, ...m.cc_list]).map((e) => e.toLowerCase()).filter((e) => e && e !== mine))];
  const first = t.messages.find((m) => m.from_email && m.from_email.toLowerCase() !== mine);
  const contact = first ? { name: first.from_name, email: first.from_email!.toLowerCase() } : others[0] ? { name: null, email: others[0] } : null;
  return (
    <div className="xl:flex xl:min-h-full">
    <CrmPanel emails={others} contact={contact} />
    <article className="min-w-0 flex-1 p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-2">
        <button type="button" onClick={onBack} className="mt-0.5 rounded p-1 text-muted hover:text-ink lg:hidden" aria-label="Retour à la liste"><ArrowLeft size={18} /></button>
        <h2 className="min-w-0 flex-1 font-display text-lg font-bold break-words">{t.subject || "(sans objet)"}</h2>
      </div>
      {act && <div className="mb-3"><ThreadActions threads={[summary ?? fromOpen(t)]} context={context} labels={labels} act={act} onGone={onGone} /></div>}
      {hidden && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-violet-soft px-3 py-2 text-xs">
          <ImageOff size={14} /> Les images distantes sont masquées : elles peuvent signaler à l&apos;expéditeur que vous avez ouvert le message.
          <button type="button" className="font-semibold underline" onClick={() => setImages(true)}>Afficher les images</button>
        </p>
      )}
      <ol className="space-y-3">
        {t.messages.map((m) => {
          const open = m.id === lastId || expanded.has(m.id);
          return (
            <li key={m.id} className="rounded-lg border border-line">
              <button type="button" disabled={m.id === lastId} onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                aria-expanded={open} className="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left">
                <span className="text-sm font-semibold text-ink">{m.from_name || m.from_email || "(expéditeur inconnu)"}</span>
                {m.from_name && m.from_email && <span className="text-xs text-muted">{m.from_email}</span>}
                {m.label_ids.includes("DRAFT") && <Badge tone="neutral">Brouillon</Badge>}
                <span className="flex-1" />
                <time dateTime={m.at} className="text-xs text-muted">{full.format(new Date(m.at))}</time>
                {open && <span className="w-full truncate text-xs text-muted">À : {m.to || "(non indiqué)"}{m.cc ? ` · Cc : ${m.cc}` : ""}</span>}
              </button>
              {open && <MessageBody m={m} threadId={t.thread_id} images={images} />}
              {open && onWrite && (
                <div className="flex flex-wrap gap-2 border-t border-line px-3 py-2">
                  {m.label_ids.includes("DRAFT")
                    ? <Button variant="secondary" size="sm" onClick={() => onWrite({ kind: "draft", message_id: m.id })}><Pencil size={13} /> Modifier le brouillon</Button>
                    : <>
                        <Button variant="secondary" size="sm" onClick={() => onWrite({ kind: "reply", thread_id: t.thread_id, message: m })}><Reply size={13} /> Répondre</Button>
                        <Button variant="secondary" size="sm" onClick={() => onWrite({ kind: "reply_all", thread_id: t.thread_id, message: m })}><ReplyAll size={13} /> Répondre à tous</Button>
                        <Button variant="secondary" size="sm" onClick={() => onWrite({ kind: "forward", thread_id: t.thread_id, message: m })}><Forward size={13} /> Transférer</Button>
                      </>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </article>
    </div>
  );
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|orange|wanadoo|free|sfr|laposte|protonmail|proton|gmx|aol)\./i;

/** Fiche prête à créer à partir d'un correspondant : société déduite du domaine, sauf messagerie personnelle. */
function prefillFrom(contact: { name: string | null; email: string }) {
  const domain = contact.email.split("@")[1] ?? "";
  const pro = !!domain && !FREE_MAIL.test(domain);
  const [firstName, ...rest] = (contact.name ?? "").trim().split(/\s+/).filter(Boolean);
  const company = pro ? domain.split(".")[0].replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()) : (contact.name ?? "");
  return { name: company, website: pro ? domain : "", person: { first_name: firstName ?? "", last_name: rest.join(" "), email: contact.email } };
}

/**
 * Lien avec le CRM : les fiches des correspondants du fil (entreprise, personne, étape, prochaine action), ou la
 * création d'une fiche préremplie quand le correspondant n'en a pas.
 */
function CrmPanel({ emails, contact }: { emails: string[]; contact: { name: string | null; email: string } | null }) {
  const { openCompany, openCreate } = useCrm();
  const q = useQuery({
    queryKey: ["mail-box-crm", emails.join(",")],
    queryFn: ({ signal }) => apiGet<BoxCrmMatch[]>(`/api/mail/box/crm?emails=${encodeURIComponent(emails.join(","))}`, signal),
    enabled: emails.length > 0, staleTime: 60_000,
  });
  if (!emails.length) return null;
  const matches = q.data ?? [];
  // une fiche n'apparaît qu'une fois, avec ses personnes présentes dans le fil
  const companies = [...new Map(matches.map((m) => [m.company.id, m])).values()];
  const known = !!contact && matches.some((m) => m.email === contact.email);
  return (
    <aside aria-label="Fiche du CRM" className="border-b border-line bg-surface/50 p-3 text-sm xl:order-last xl:w-64 xl:shrink-0 xl:border-b-0 xl:border-l">
      {q.isLoading && <Skeleton className="h-16 w-full" />}
      {q.isError && <p className="text-xs text-danger">Fiches indisponibles. <button type="button" className="underline" onClick={() => q.refetch()}>Réessayer</button></p>}
      {companies.map((m) => (
        <div key={m.company.id} className="mb-3 last:mb-0">
          <button type="button" onClick={() => openCompany(m.company.id, { name: m.company.name })} className="flex w-full items-center gap-1.5 text-left font-display font-bold text-ink hover:text-violet-strong">
            <Building2 size={15} className="shrink-0" /> <span className="truncate">{m.company.name}</span>
          </button>
          {matches.filter((x) => x.company.id === m.company.id).map((x) => (
            <p key={x.person.id} className="mt-0.5 truncate text-xs text-muted">{x.person.name ?? x.email}{x.person.title ? ` · ${x.person.title}` : ""}</p>
          ))}
          <p className="mt-1.5 text-xs"><span className="text-muted">Étape : </span>{m.stage ? `${m.pipeline ? `${m.pipeline} › ` : ""}${m.stage}` : (PROSPECT_STATUS_LABELS[m.company.prospect_status as keyof typeof PROSPECT_STATUS_LABELS] ?? "Hors pipeline")}</p>
          <p className="mt-0.5 flex items-start gap-1 text-xs"><CalendarClock size={12} className="mt-0.5 shrink-0 text-muted" />
            {m.next_action ? <span>{m.next_action.title} <span className="text-muted">· {formatDate(m.next_action.due_date)}</span></span> : <span className="text-muted">Aucune action prévue</span>}
          </p>
        </div>
      ))}
      {q.isSuccess && contact && !known && (
        <div className={companies.length ? "mt-3 border-t border-line pt-3" : undefined}>
          <p className="text-xs text-muted">{contact.name ?? contact.email} n&apos;a pas de fiche.</p>
          <Button variant="secondary" size="sm" className="mt-1.5" onClick={() => openCreate({ prefill: prefillFrom(contact), onCreated: () => void q.refetch() })}><UserPlus size={13} /> Créer la fiche</Button>
        </div>
      )}
    </aside>
  );
}

/** Résumé d'un fil ouvert depuis une recherche ou un lien, quand la liste ne le contient pas. */
function fromOpen(t: BoxOpenThread): BoxThread {
  const label_ids = [...new Set(t.messages.flatMap((m) => m.label_ids))];
  const last = t.messages.at(-1);
  return { thread_id: t.thread_id, last_at: last?.at ?? "", subject: t.subject, snippet: "", participants: [], message_count: t.messages.length, label_ids,
    unread: label_ids.includes("UNREAD"), starred: label_ids.includes("STARRED"), important: label_ids.includes("IMPORTANT"), has_attachments: t.messages.some((m) => m.attachments.length > 0) };
}

// Cadre isolé : aucun script n'y tourne (attribut sandbox sans « allow-scripts ») et sa politique de contenu
// bloque tout chargement distant, sauf les images quand l'utilisateur les demande. Les liens s'ouvrent ailleurs.
const frameDoc = (html: string, images: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https:" : ""}"><base target="_blank"><style>html,body{margin:0;padding:0}body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1b22;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #ddd;color:#555}a{color:#5b3fd6}</style></head><body>${html}</body></html>`;

function MessageBody({ m, threadId, images }: { m: BoxOpenMessage; threadId: string; images: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const doc = useMemo(() => frameDoc(m.html, images), [m.html, images]);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const fit = () => {
    const d = frame.current?.contentDocument;
    if (!d?.documentElement) return;
    const measure = () => setHeight(Math.min(20_000, Math.max(40, d.documentElement.scrollHeight)));
    measure();
    // une image qui finit de charger change la hauteur
    observer.current?.disconnect();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(d.body);
  };
  return (
    <div className="border-t border-line px-3 py-3">
      <iframe ref={frame} title="Contenu du message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} onLoad={fit} style={{ height }} className="block w-full border-0" />
      {m.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Pièces jointes">
          {m.attachments.map((a, i) => (
            <li key={i}>
              <a href={`/api/mail/box/attachment?${new URLSearchParams({ thread: threadId, message: m.id, n: String(i) })}`} download={a.name}
                className="inline-flex max-w-xs items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold hover:border-violet hover:bg-violet-soft">
                <File size={13} className="shrink-0" /> <span className="truncate">{a.name}</span> <span className="shrink-0 font-normal text-muted">{size(a.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
