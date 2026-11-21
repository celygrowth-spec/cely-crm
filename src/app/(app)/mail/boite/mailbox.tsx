"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Archive, ArrowLeft, File, FileText, Flag, Folder, ImageOff, Inbox, OctagonAlert, Paperclip, RefreshCw, Search, Send, Star, Tag, Trash2, X } from "lucide-react";
import { Badge, Button, EmptyState, Input, Select, Skeleton, cn } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import { TZ } from "@/lib/format";
import { CATEGORY_FOLDERS, SYSTEM_FOLDERS, type BoxFolder, type BoxOpenMessage, type BoxOpenThread, type BoxThread, type BoxThreadPage } from "@/lib/mail/box-types";
import { BOX_TONE } from "../box-status";
import { BOX_KEY, useBoxSync } from "../use-box-sync";

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

export function Mailbox() {
  const { status, syncing, run } = useBoxSync();
  const folders = useFolders();
  const [label, setLabel] = useState("INBOX");
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

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
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQuery(typed.trim());
    setOpenId(null);
  };
  const all = [...folders.system, ...folders.categories, ...folders.labels];
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
          <ThreadList threads={threads} openId={openId} onOpen={setOpenId} loading={list.isLoading} error={list.isError ? list.error.message : null} retry={() => list.refetch()}
            hasMore={!!list.hasNextPage} loadingMore={list.isFetchingNextPage} more={() => list.fetchNextPage()} empty={query ? "Aucun message ne correspond à cette recherche." : "Aucun message dans ce dossier."} />
        </section>

        {/* Fil ouvert */}
        <section aria-label="Message" className={cn("min-h-0 min-w-0 overflow-y-auto", !openId && "hidden lg:block")}>
          {openId ? <Reader key={openId} id={openId} onBack={() => setOpenId(null)} /> : <p className="p-8 text-center text-sm text-muted">Choisissez un message pour le lire.</p>}
        </section>
      </div>
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

function ThreadList(p: { threads: BoxThread[]; openId: string | null; onOpen: (id: string) => void; loading: boolean; error: string | null; retry: () => void; hasMore: boolean; loadingMore: boolean; more: () => void; empty: string }) {
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
        <li key={t.thread_id}>
          <button type="button" onClick={() => p.onOpen(t.thread_id)} aria-current={p.openId === t.thread_id ? "true" : undefined}
            className={cn("block w-full px-3 py-2 text-left hover:bg-violet-soft/60", p.openId === t.thread_id && "bg-violet-soft", t.unread ? "text-ink" : "text-muted")}>
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

function Reader({ id, onBack }: { id: string; onBack: () => void }) {
  const [images, setImages] = useState(false);
  const q = useQuery({
    queryKey: [...BOX_KEY, "thread", id, images],
    queryFn: ({ signal }) => apiGet<BoxOpenThread>(`/api/mail/box/threads/${encodeURIComponent(id)}${images ? "?images=1" : ""}`, signal),
    placeholderData: (previous) => previous,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (q.isLoading) return <div className="space-y-3 p-5"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) return <p className="p-5 text-sm text-danger">{q.error?.message ?? "Lecture impossible"} <button type="button" className="underline" onClick={() => q.refetch()}>Réessayer</button> · <button type="button" className="underline" onClick={onBack}>Retour</button></p>;
  const t = q.data;
  const lastId = t.messages.at(-1)?.id;
  const hidden = !images && t.messages.some((m) => m.remote_images);
  return (
    <article className="p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-2">
        <button type="button" onClick={onBack} className="mt-0.5 rounded p-1 text-muted hover:text-ink lg:hidden" aria-label="Retour à la liste"><ArrowLeft size={18} /></button>
        <h2 className="min-w-0 flex-1 font-display text-lg font-bold break-words">{t.subject || "(sans objet)"}</h2>
      </div>
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
            </li>
          );
        })}
      </ol>
    </article>
  );
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
