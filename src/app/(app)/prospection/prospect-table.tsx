"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Search } from "lucide-react";
import { addCompaniesToCampaignAction, addToListAction, setArchivedAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, EmptyState, Input, PageHeader, Select, cn } from "@/components/ui";
import type { CompanyOverview, ProspectStatus } from "@/lib/crm/types";
import { PROSPECT_STATUS_LABELS, relativeDay, todayISO } from "@/lib/format";

type SortKey = "name" | "contact" | "source" | "status" | "last" | "next" | "created";

const statusTone: Record<ProspectStatus, "neutral" | "violet" | "success" | "warning" | "danger"> = {
  nouveau: "neutral",
  contacte: "violet",
  en_discussion: "warning",
  qualifie: "success",
  pas_interesse: "danger",
};

export function ProspectTable({ rows, showArchived, campaigns }: { rows: CompanyOverview[]; showArchived: boolean; campaigns: { id: string; name: string }[] }) {
  const { sources, lists, pipelines, openCompany, openCreate } = useCrm();
  const router = useRouter();
  const [q, setQ] = useState("");
  const sp = useSearchParams();
  const [listId, setListId] = useState(sp.get("list") ?? "");
  const [sourceId, setSourceId] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("");
  const [inPipeline, setInPipeline] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "created", asc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sourceName = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const listName = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);
  const stageName = useMemo(() => {
    const m = new Map<string, string>();
    pipelines.forEach((p) => p.stages.forEach((s) => m.set(s.id, `${p.name} › ${s.name}`)));
    return m;
  }, [pipelines]);
  const allTags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const res = rows.filter((r) => {
      if (needle) {
        const hay = `${r.name} ${r.domain_norm ?? ""} ${r.website ?? ""} ${r.people_search}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (listId && !r.list_ids.includes(listId)) return false;
      if (sourceId && r.source_id !== sourceId) return false;
      if (tag && !r.tags.includes(tag)) return false;
      if (status && r.prospect_status !== status) return false;
      if (inPipeline === "yes" && !r.pipeline_id) return false;
      if (inPipeline === "no" && r.pipeline_id) return false;
      return true;
    });
    const val = (r: CompanyOverview): string => {
      switch (sort.key) {
        case "name": return r.name.toLowerCase();
        case "contact": return (r.primary_person_name ?? "").toLowerCase();
        case "source": return (r.source_id ? sourceName.get(r.source_id) : "") ?? "";
        case "status": return r.prospect_status;
        case "last": return r.last_interaction_at ?? "";
        case "next": return r.next_action_due ?? "9999";
        case "created": return r.created_at;
      }
    };
    return res.sort((a, b) => (sort.asc ? 1 : -1) * val(a).localeCompare(val(b)));
  }, [rows, q, listId, sourceId, tag, status, inPipeline, sort, sourceName]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const ids = [...selected];

  async function bulkList(id: string) {
    if (!id) return;
    const res = await addToListAction(id, ids);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${ids.length} fiche(s) ajoutée(s) à « ${listName.get(id)} »`);
    router.refresh();
  }
  async function bulkArchive() {
    const verb = showArchived ? "Restaurer" : "Archiver";
    if (!confirm(`${verb} ${ids.length} fiche(s) ?`)) return;
    const res = await setArchivedAction(ids, !showArchived);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data} fiche(s) ${showArchived ? "restaurée(s)" : "archivée(s)"}`);
    setSelected(new Set());
    router.refresh();
  }
  async function bulkCampaign(id: string) {
    if (!id) return;
    const res = await addCompaniesToCampaignAction(id, ids);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data.added} ajoutée(s) à la campagne${res.data.already_present ? `, ${res.data.already_present} déjà présente(s)` : ""}`);
    router.refresh();
  }

  const today = todayISO();
  const filtersActive = q || listId || sourceId || tag || status || inPipeline;

  return (
    <div>
      <PageHeader
        title={showArchived ? "Fiches archivées" : "Base de prospects"}
        description={`${filtered.length} fiche(s)${filtered.length !== rows.length ? ` sur ${rows.length}` : ""}`}
        actions={
          <>
            <Link href={showArchived ? "/prospection" : "/prospection?archived=1"} className="text-sm font-semibold text-muted hover:text-ink">
              {showArchived ? "← Fiches actives" : "Voir les archivées"}
            </Link>
            {!showArchived && <Button variant="primary" onClick={() => openCreate({ listId: listId || undefined })}><Plus size={15} /> Nouvelle fiche</Button>}
          </>
        }
      />

      {rows.length === 0 ? (
        showArchived ? (
          <EmptyState title="Aucune fiche archivée" />
        ) : (
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
        )
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative min-w-56 flex-1">
              <Search size={15} className="absolute top-2.5 left-3 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Entreprise, personne, email, domaine" className="pl-9" />
            </div>
            <Select value={listId} onChange={(e) => setListId(e.target.value)} className="w-auto" aria-label="Liste">
              <option value="">Toutes les listes</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
            <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-auto" aria-label="Source">
              <option value="">Toutes les sources</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {allTags.length > 0 && (
              <Select value={tag} onChange={(e) => setTag(e.target.value)} className="w-auto" aria-label="Tag">
                <option value="">Tous les tags</option>
                {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
              </Select>
            )}
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Statut">
              <option value="">Tous les statuts</option>
              {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select value={inPipeline} onChange={(e) => setInPipeline(e.target.value)} className="w-auto" aria-label="Pipeline">
              <option value="">Pipeline : tous</option>
              <option value="yes">Dans un pipeline</option>
              <option value="no">Hors pipeline</option>
            </Select>
            {filtersActive && (
              <Button variant="ghost" onClick={() => { setQ(""); setListId(""); setSourceId(""); setTag(""); setStatus(""); setInPipeline(""); }}>Effacer</Button>
            )}
          </div>

          {selected.size > 0 && (
            <div className="sticky top-14 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-violet-line bg-violet-soft px-3 py-2 md:top-2">
              <span className="text-sm font-semibold">{selected.size} sélectionnée(s)</span>
              {!showArchived && lists.length > 0 && (
                <Select value="" onChange={(e) => bulkList(e.target.value)} className="h-8 w-auto text-xs" aria-label="Ajouter à une liste">
                  <option value="">Ajouter à une liste…</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              )}
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

          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-line bg-surface">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Tout sélectionner"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.id)))}
                    />
                  </th>
                  <Th sort={sort} setSort={setSort} k="name">Entreprise</Th>
                  <Th sort={sort} setSort={setSort} k="contact">Contact principal</Th>
                  <Th sort={sort} setSort={setSort} k="source">Source</Th>
                  <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">Listes</th>
                  <Th sort={sort} setSort={setSort} k="status">Statut</Th>
                  <Th sort={sort} setSort={setSort} k="last">Dernier échange</Th>
                  <Th sort={sort} setSort={setSort} k="next">Prochaine action</Th>
                  <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">Pipeline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((r) => (
                  <tr key={r.id} className={cn("cursor-pointer hover:bg-violet-soft/40", selected.has(r.id) && "bg-violet-soft/60")} onClick={() => openCompany(r.id)}>
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
                    <td className="px-3 py-2 text-muted">{r.source_id ? sourceName.get(r.source_id) : "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-48 flex-wrap gap-1">
                        {r.list_ids.map((id) => <Badge key={id}>{listName.get(id)}</Badge>)}
                      </div>
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
                        <Badge tone={r.deal_status === "won" ? "success" : r.deal_status === "lost" ? "danger" : "violet"}>
                          {stageName.get(r.stage_id) ?? "Pipeline"}
                        </Badge>
                      ) : <span className="text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <p className="p-6 text-center text-sm text-muted">Aucune fiche ne correspond aux filtres.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function Th({
  k,
  sort,
  setSort,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; asc: boolean };
  setSort: React.Dispatch<React.SetStateAction<{ key: SortKey; asc: boolean }>>;
  children: React.ReactNode;
}) {
  return (
    <th className="px-3 py-2 text-left font-label text-xs font-semibold text-muted">
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort((s) => ({ key: k, asc: s.key === k ? !s.asc : true }))}>
        {children}
        {sort.key === k && (sort.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}
