"use client";

// Liste des articles : filtre par statut (effectif : un programmé dont la date est passée est publié), recherche,
// création (titre seul, puis éditeur).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { createEntryAction } from "@/app/cms-actions";
import { Badge, Button, EmptyState, Input, Modal, PageHeader, cn } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis } from "@/lib/cms/dates";
import { STATUS_LABEL, STATUS_TONE, effectiveStatus, type CmsEntry, type CmsStatus } from "@/lib/cms/types";

const FILTERS: ("all" | CmsStatus)[] = ["all", "draft", "scheduled", "published", "unpublished"];

export function ArticlesView({ entries, toolbar }: { entries: CmsEntry[]; toolbar?: ReactNode }) {
  const [filter, setFilter] = useState<"all" | CmsStatus>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => entries.map((e) => ({ e, s: effectiveStatus(e) })), [entries]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    rows.forEach((r) => (c[r.s] = (c[r.s] ?? 0) + 1));
    return c;
  }, [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === "all" || r.s === filter) && (!needle || r.e.title.toLowerCase().includes(needle) || r.e.slug.includes(needle)));

  return (
    <div className="mx-auto max-w-5xl" data-cms-articles>
      <PageHeader
        title="Articles"
        description="Les articles du blog de celygrowth.com. Le site les affiche seul à la date prévue."
        actions={<div className="flex flex-wrap gap-2">{toolbar}<Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} /> Nouvel article</Button></div>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filtrer par statut" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} data-filter={f}
              className={cn("rounded-lg px-2.5 py-1 text-sm font-semibold", filter === f ? "bg-ink text-white" : "text-muted hover:bg-violet-soft")}>
              {f === "all" ? "Tous" : STATUS_LABEL[f]} <span className="tabular-nums opacity-70">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un titre ou un slug" className="ml-auto max-w-xs" aria-label="Rechercher" />
      </div>
      {!entries.length ? (
        <EmptyState title="Aucun article" description="Créez votre premier article ou importez des fichiers Markdown."
          action={<Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} /> Nouvel article</Button>} />
      ) : !shown.length ? (
        <p className="text-sm text-muted">Aucun article pour ce filtre.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">
          {shown.map(({ e, s }) => (
            <li key={e.id}>
              <Link href={`/cms/articles/${e.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-violet-soft/30" data-cms-row={e.slug}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{e.title}</span>
                  <span className="block truncate text-xs text-muted">/{e.slug}{e.category ? ` · ${e.category}` : ""}</span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted sm:inline">{e.publish_at ? formatParis(e.publish_at) : "Non daté"}</span>
                <Badge tone={STATUS_TONE[s]} data-status={s}>{STATUS_LABEL[s]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <CreateEntry open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateEntry({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(() => crypto.randomUUID());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await attempt(() => createEntryAction(id, { title }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setId(crypto.randomUUID());
    router.push(`/cms/articles/${r.data.id}`);
  }
  return (
    <Modal open={open} onClose={onClose} title="Nouvel article">
      <form onSubmit={submit} className="space-y-3">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre de l'article" aria-label="Titre" maxLength={300} />
        <p className="text-xs text-muted">Le slug est créé à partir du titre ; vous pourrez le modifier.</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>{busy ? "Création…" : "Créer et ouvrir"}</Button>
        </div>
      </form>
    </Modal>
  );
}
