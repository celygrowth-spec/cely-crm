"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Search } from "lucide-react";
import { addToListAction, setArchivedAction, setCompaniesSourceAction } from "@/app/actions";
import { enrollAction } from "@/app/prospection-actions";
import { useCrm } from "@/components/app-shell";
import { SourceBadge, SourcePicker } from "@/components/source-picker";
import { Badge, Button, EmptyState, Input, PageHeader, Select, Skeleton, cn } from "@/components/ui";
import { attempt, apiGet, useSync } from "@/lib/client/query";
import type { CompanyOverview, ProspectStatus } from "@/lib/crm/types";
import { PROSPECT_STATUS_LABELS, relativeDay, todayISO } from "@/lib/format";

type SortKey = "name" | "contact" | "source" | "status" | "last" | "next" | "created";
type Row = Pick<CompanyOverview, "id" | "name" | "website" | "domain_norm" | "source_id" | "tags" | "prospect_status" | "pipeline_id" | "stage_id" | "deal_status" | "last_interaction_at" | "archived_at" | "created_at" | "primary_person_name" | "people_count" | "list_ids" | "next_action_title" | "next_action_due">;
type Page = { total: number; rows: Row[] };

const PAGE = 50;
const statusTone: Record<ProspectStatus, "neutral" | "violet" | "success" | "warning" | "danger"> = {
  nouveau: "neutral",
  contacte: "violet",
  en_discussion: "warning",
  qualifie: "success",
  pas_interesse: "danger",
};

export function ProspectTable({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const { sources, lists, pipelines, openCompany, openCreate, prefetchCompany } = useCrm();
  const sync = useSync();
  const qc = useQueryClient();
  const sp = useSearchParams();
  // les filtres vivent dans l'URL : retour depuis une fiche, rechargement et lien direct les conservent
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [debounced, setDebounced] = useState(q.trim());
  const [listId, setListId] = useState(sp.get("list") ?? "");
  const [sourceId, setSourceId] = useState(sp.get("source") ?? "");
  const [tag, setTag] = useState(sp.get("tag") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [inPipeline, setInPipeline] = useState(sp.get("pipeline") ?? "");
  const [showArchived, setShowArchived] = useState(sp.get("archived") === "1");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: (sp.get("sort") as SortKey) || "created", asc: sp.get("asc") === "1" });
  const [page, setPage] = useState(Number(sp.get("page") ?? 0) || 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);
  const [prevDebounced, setPrevDebounced] = useState(debounced);
  if (debounced !== prevDebounced) {
    setPrevDebounced(debounced);
    setPage(0);
  }

  const query = useMemo(() => {
    const u = new URLSearchParams();
    if (debounced) u.set("q", debounced);
    if (listId) u.set("list", listId);
    if (sourceId) u.set("source", sourceId);
    if (tag) u.set("tag", tag);
    if (status) u.set("status", status);
    if (inPipeline) u.set("pipeline", inPipeline);
    if (showArchived) u.set("archived", "1");
    if (sort.key !== "created") u.set("sort", sort.key);
    if (sort.asc) u.set("asc", "1");
    return u;
  }, [debounced, listId, sourceId, tag, status, inPipeline, showArchived, sort]);

  useEffect(() => {
    const u = new URLSearchParams(query);
    if (page) u.set("page", String(page));
    const fiche = new URLSearchParams(window.location.search).get("fiche");
    if (fiche) u.set("fiche", fiche);
    const s = u.toString();
    window.history.replaceState(null, "", s ? `${window.location.pathname}?${s}` : window.location.pathname);
  }, [query, page]);

  const key = ["companies", query.toString(), page];
  const { data, isLoading, isFetching, isError, error, refetch, isPlaceholderData } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Page>(`/api/companies?${query}&limit=${PAGE}&offset=${page * PAGE}`, signal),
    placeholderData: keepPreviousData, // le tableau reste visible pendant un filtrage
  });
  const { data: allTags = [] } = useQuery({ queryKey: ["company-tags"], queryFn: ({ signal }) => apiGet<string[]>("/api/companies?tags=1", signal), staleTime: 120_000 });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const listName = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);
  const stageName = useMemo(() => {
    const m = new Map<string, string>();
    pipelines.forEach((p) => p.stages.forEach((s) => m.set(s.id, `${p.name} › ${s.name}`)));
    return m;
  }, [pipelines]);

  const reset = () => { setPage(0); setSelected(new Set()); };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const ids = [...selected];
  const filtersActive = !!(q || listId || sourceId || tag || status || inPipeline);
  const today = todayISO();

  async function selectAllResults() {
    const all = await apiGet<string[]>(`/api/companies?${query}&ids=1`);
    setSelected(new Set(all));
  }
  async function bulkList(id: string) {
    if (!id) return;
    const res = await attempt(() => addToListAction(id, ids));
    if (!res.ok) return toast.error(res.error);
    toast.success(`${ids.length} fiche(s) ajoutée(s) à « ${listName.get(id)} »`);
    sync(["companies"]);
  }
  async function bulkSource(id: string | null) {
    const res = await attempt(() => setCompaniesSourceAction(ids, id));
    if (!res.ok) return toast.error(res.error);
    toast.success(`Source modifiée sur ${res.data} fiche(s)`);
    sync(["companies"]);
    ids.forEach((x) => qc.invalidateQueries({ queryKey: ["company", x] }));
  }
  async function bulkArchive() {
    const verb = showArchived ? "Restaurer" : "Archiver";
    if (!confirm(`${verb} ${ids.length} fiche(s) ?`)) return;
    const res = await attempt(() => setArchivedAction(ids, !showArchived));
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data} fiche(s) ${showArchived ? "restaurée(s)" : "archivée(s)"}`);
    setSelected(new Set());
    sync(["companies"]);
  }
  async function bulkCampaign(id: string) {
    if (!id) return;
    const res = await attempt(() => enrollAction(id, ids, []));
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data.added} ajoutée(s) à préparer${res.data.already_present ? `, ${res.data.already_present} déjà présente(s)` : ""}${res.data.blocked ? `, ${res.data.blocked} bloquée(s)` : ""}`);
    sync();
  }

  const header = (
    <PageHeader
      title={showArchived ? "Fiches archivées" : "Base de prospects"}
      description={data ? `${total} fiche(s)` : " "}
      actions={
        <>
          <button onClick={() => { setShowArchived((s) => !s); reset(); }} className="text-sm font-semibold text-muted hover:text-ink">
            {showArchived ? "← Fiches actives" : "Voir les archivées"}
          </button>
          {!showArchived && <Button variant="primary" onClick={() => openCreate({ listId: listId || undefined })}><Plus size={15} /> Nouvelle fiche</Button>}
        </>
      }
    />
  );

  if (!isLoading && !isError && total === 0 && !filtersActive) {
    return (
      <div>
        {header}
        {showArchived ? <EmptyState title="Aucune fiche archivée" /> : (
          <EmptyState
            title="Votre base est vide"
            description="Créez votre première fiche ou importez un fichier CSV de prospects."
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => openCreate()}><Plus size={15} /> Créer une fiche</Button>
                <Link href="/prospection/import" className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-violet-soft">Importer un CSV</Link>
              </div>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={15} className="absolute top-2.5 left-3 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Entreprise, personne, email, domaine" className="pl-9" />
        </div>
        <Select value={listId} onChange={(e) => { setListId(e.target.value); reset(); }} className="w-auto" aria-label="Liste">
          <option value="">Toutes les listes</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Select value={sourceId} onChange={(e) => { setSourceId(e.target.value); reset(); }} className="w-auto" aria-label="Source">
          <option value="">Toutes les sources</option>
          <option value="none">Sans source</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.archived_at ? " (archivée)" : ""}</option>)}
        </Select>
        {allTags.length > 0 && (
          <Select value={tag} onChange={(e) => { setTag(e.target.value); reset(); }} className="w-auto" aria-label="Tag">
            <option value="">Tous les tags</option>
            {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </Select>
        )}
        <Select value={status} onChange={(e) => { setStatus(e.target.value); reset(); }} className="w-auto" aria-label="Statut">
          <option value="">Tous les statuts</option>
          {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={inPipeline} onChange={(e) => { setInPipeline(e.target.value); reset(); }} className="w-auto" aria-label="Pipeline">
          <option value="">Pipeline : tous</option>
          <option value="yes">Dans un pipeline</option>
          <option value="no">Hors pipeline</option>
        </Select>
        {filtersActive && (
          <Button variant="ghost" onClick={() => { setQ(""); setListId(""); setSourceId(""); setTag(""); setStatus(""); setInPipeline(""); reset(); }}>Effacer</Button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="pop-in sticky top-14 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-violet-line bg-violet-soft px-3 py-2 md:top-2">
          <span className="text-sm font-semibold">{selected.size} sélectionnée(s)</span>
          {allSelected && selected.size < total && <button className="text-xs font-semibold text-violet-strong underline" onClick={selectAllResults}>Sélectionner les {total} résultats</button>}
          {!showArchived && lists.length > 0 && (
            <Select value="" onChange={(e) => bulkList(e.target.value)} className="h-8 w-auto text-xs" aria-label="Ajouter à une liste">
              <option value="">Ajouter à une liste…</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}
          <SourcePicker sources={sources} value={null} onChange={(id) => bulkSource(id)} placeholder="Changer la source…" className="w-48 [&>button]:h-8 [&>button]:text-xs" />
          {!showArchived && campaigns.length > 0 && (
            <Select value="" onChange={(e) => bulkCampaign(e.target.value)} className="h-8 w-auto text-xs" aria-label="Ajouter à une campagne">
              <option value="">Ajouter à une campagne…</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
          <Button size="sm" onClick={bulkArchive}>{showArchived ? "Restaurer" : "Archiver"}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Désélectionner</Button>
        </div>
      )}

      {isError && !data && <p className="mb-2 text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>}

      <div className={cn("overflow-x-auto rounded-xl border border-line transition-opacity duration-150", isPlaceholderData && isFetching && "opacity-60")}>
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-line bg-surface">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" aria-label="Sélectionner la page" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
              </th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="name">Entreprise</Th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="contact">Contact principal</Th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="source">Source</Th>
              <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">Listes</th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="status">Statut</Th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="last">Dernier échange</Th>
              <Th sort={sort} setSort={(s) => { setSort(s); setPage(0); }} k="next">Prochaine action</Th>
              <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">Pipeline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {isLoading && Array.from({ length: 10 }, (_, i) => (
              <tr key={i}>{Array.from({ length: 9 }, (_, j) => <td key={j} className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>)}</tr>
            ))}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={cn("cursor-pointer hover:bg-violet-soft/40", selected.has(r.id) && "bg-violet-soft/60")}
                onMouseEnter={() => prefetchCompany(r.id)}
                onClick={() => openCompany(r.id, { name: r.name, website: r.website, domain_norm: r.domain_norm })}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Sélectionner ${r.name}`} />
                </td>
                <td className="px-3 py-2">
                  <p className="font-semibold">{r.name}</p>
                  {r.domain_norm && <p className="text-xs text-muted">{r.domain_norm}</p>}
                </td>
                <td className="px-3 py-2">
                  <p>{r.primary_person_name ?? <span className="text-muted">—</span>}</p>
                  {r.people_count > 1 && <p className="text-xs text-muted">+{r.people_count - 1} personne(s)</p>}
                </td>
                <td className="px-3 py-2"><SourceBadge source={r.source_id ? sourceById.get(r.source_id) : null} /></td>
                <td className="px-3 py-2">
                  <div className="flex max-w-48 flex-wrap gap-1">{r.list_ids.map((id) => <Badge key={id}>{listName.get(id)}</Badge>)}</div>
                </td>
                <td className="px-3 py-2"><Badge tone={statusTone[r.prospect_status]}>{PROSPECT_STATUS_LABELS[r.prospect_status]}</Badge></td>
                <td className="px-3 py-2 text-muted">{r.last_interaction_at ? relativeDay(r.last_interaction_at) : "—"}</td>
                <td className="px-3 py-2">
                  {r.next_action_title ? (
                    <div>
                      <p className="max-w-52 truncate">{r.next_action_title}</p>
                      <p className={cn("text-xs", r.next_action_due! < today ? "font-semibold text-danger" : "text-muted")}>{relativeDay(r.next_action_due)}</p>
                    </div>
                  ) : <span className="text-muted">—</span>}
                </td>
                <td className="px-3 py-2">
                  {r.stage_id ? (
                    <Badge tone={r.deal_status === "won" ? "success" : r.deal_status === "lost" ? "danger" : "violet"}>{stageName.get(r.stage_id) ?? "Pipeline"}</Badge>
                  ) : <span className="text-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && !rows.length && <p className="p-6 text-center text-sm text-muted">Aucune fiche ne correspond aux filtres.</p>}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Précédent</Button>
          Page {page + 1} / {pages}
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Suivant</Button>
        </div>
      )}
    </div>
  );
}

function Th({ k, sort, setSort, children }: { k: SortKey; sort: { key: SortKey; asc: boolean }; setSort: (s: { key: SortKey; asc: boolean }) => void; children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : true })}>
        {children}
        {sort.key === k && (sort.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}
