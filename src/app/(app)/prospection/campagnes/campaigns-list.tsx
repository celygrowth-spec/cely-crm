"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Archive, Copy, LayoutGrid, Pause, Play, Plus, Rows3, Search } from "lucide-react";
import { createCampaignAction, duplicateCampaignAction, setCampaignStatusAction } from "@/app/prospection-actions";
import { CAMPAIGN_STATUS, CampaignStatusBadge, ChannelChip } from "@/components/prospection/bits";
import { Button, EmptyState, Field, Input, Modal, PageHeader, Select, cn } from "@/components/ui";
import type { CampaignOverview, CampaignStatus } from "@/lib/prospection/service";
import { relativeDay } from "@/lib/format";

type SortKey = "name" | "status" | "enrolled" | "in_progress" | "due_today" | "overdue" | "replied" | "interested" | "meetings" | "last_activity_at";

const COLS: { key: SortKey; label: string; title?: string }[] = [
  { key: "enrolled", label: "Inscrites", title: "Entreprises inscrites" },
  { key: "in_progress", label: "En cours", title: "Participants dont la séquence est en cours" },
  { key: "due_today", label: "Auj.", title: "Actions à faire aujourd'hui" },
  { key: "overdue", label: "Retard", title: "Actions en retard" },
  { key: "replied", label: "Réponses", title: "Entreprises ayant répondu" },
  { key: "interested", label: "Intéressées", title: "Entreprises intéressées (y compris RDV)" },
  { key: "meetings", label: "RDV", title: "Rendez-vous obtenus" },
];

export function CampaignsList({ campaigns, templates }: { campaigns: CampaignOverview[]; templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("live");
  const [channel, setChannel] = useState("");
  const [view, setView] = useState<"table" | "cards">("table");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "last_activity_at", asc: false });
  const [createOpen, setCreateOpen] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const r = campaigns.filter(
      (c) =>
        (!needle || c.name.toLowerCase().includes(needle)) &&
        (status === "" || (status === "live" ? c.status !== "archived" : c.status === status)) &&
        (!channel || c.channels.includes(channel)),
    );
    const order: CampaignStatus[] = ["active", "draft", "paused", "finished", "archived"];
    return r.sort((a, b) => {
      const k = sort.key;
      const va = k === "name" ? a.name.toLowerCase() : k === "status" ? order.indexOf(a.status) : k === "last_activity_at" ? a.last_activity_at ?? "" : a[k];
      const vb = k === "name" ? b.name.toLowerCase() : k === "status" ? order.indexOf(b.status) : k === "last_activity_at" ? b.last_activity_at ?? "" : b[k];
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.asc ? 1 : -1);
    });
  }, [campaigns, q, status, channel, sort]);

  async function act(fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, msg: string, open?: (d: unknown) => string) {
    const r = await fn();
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    if (open) router.push(open(r.data));
    else router.refresh();
  }

  const totals = campaigns.filter((c) => c.status === "active").reduce((t, c) => ({ due: t.due + c.due_today, late: t.late + c.overdue }), { due: 0, late: 0 });

  return (
    <div>
      <PageHeader
        title="Campagnes"
        description={`${campaigns.filter((c) => c.status === "active").length} active(s) · ${totals.due} action(s) aujourd'hui · ${totals.late} en retard`}
        actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> Créer une campagne</Button>}
      />

      {!campaigns.length ? (
        <EmptyState
          title="Aucune campagne"
          description="Une campagne réunit une séquence d'étapes manuelles et les entreprises à contacter. Rien n'est jamais envoyé automatiquement."
          action={<Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> Créer une campagne</Button>}
        />
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-1 mb-2 flex flex-wrap items-center gap-2 bg-white px-1 py-1.5">
            <div className="relative min-w-52 flex-1">
              <Search size={14} className="absolute top-2.5 left-2.5 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une campagne" className="h-8 pl-8" />
            </div>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-auto" aria-label="Statut">
              <option value="live">Toutes sauf archivées</option>
              <option value="">Toutes</option>
              {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
            <Select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-8 w-auto" aria-label="Canal">
              <option value="">Tous les canaux</option>
              <option value="linkedin">LinkedIn</option>
              <option value="email">Email</option>
              <option value="phone">Appel</option>
              <option value="other">Tâche</option>
            </Select>
            <div className="ml-auto flex rounded-lg border border-line p-0.5">
              <button onClick={() => setView("table")} className={cn("rounded-md px-2 py-1", view === "table" && "bg-violet-soft")} aria-label="Vue tableau"><Rows3 size={14} /></button>
              <button onClick={() => setView("cards")} className={cn("rounded-md px-2 py-1", view === "cards" && "bg-violet-soft")} aria-label="Vue cartes"><LayoutGrid size={14} /></button>
            </div>
          </div>

          {view === "table" ? (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[1050px] text-sm">
                <thead className="sticky top-0 border-b border-line bg-surface text-left">
                  <tr>
                    <Th k="name" sort={sort} setSort={setSort}>Campagne</Th>
                    <Th k="status" sort={sort} setSort={setSort}>Statut</Th>
                    <th className="px-3 py-2 font-label text-xs font-semibold text-muted">Canaux</th>
                    {COLS.map((c) => <Th key={c.key} k={c.key} sort={sort} setSort={setSort} title={c.title} right>{c.label}</Th>)}
                    <Th k="last_activity_at" sort={sort} setSort={setSort}>Activité</Th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((c) => (
                    <tr key={c.id} className="group hover:bg-violet-soft/30">
                      <td className="px-3 py-2">
                        <Link href={`/prospection/campagnes/${c.id}`} className="font-semibold hover:text-violet-strong">{c.name}</Link>
                        <p className="text-xs text-muted">{c.step_count} étape(s){c.to_prepare ? ` · ${c.to_prepare} à préparer` : ""}</p>
                      </td>
                      <td className="px-3 py-2"><CampaignStatusBadge status={c.status} /></td>
                      <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{c.channels.map((ch) => <ChannelChip key={ch} channel={ch} />)}</div></td>
                      {COLS.map((col) => {
                        const v = c[col.key as keyof CampaignOverview] as number;
                        const href = col.key === "overdue" ? "prospects?vue=retard" : col.key === "replied" ? "prospects?vue=repondu" : col.key === "interested" ? "prospects?vue=interesse" : col.key === "in_progress" ? "prospects?vue=en_cours" : col.key === "due_today" ? "prospects?vue=a_relancer" : "prospects";
                        return (
                          <td key={col.key} className="px-3 py-2 text-right tabular-nums">
                            <Link href={`/prospection/campagnes/${c.id}/${href}`} className={cn("rounded px-1 hover:bg-white", v === 0 && "text-muted", col.key === "overdue" && v > 0 && "font-bold text-danger")}>{v}</Link>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-xs text-muted">{c.last_activity_at ? relativeDay(c.last_activity_at) : "—"}</td>
                      <td className="px-2 py-2">
                        <RowActions c={c} act={act} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && <p className="p-6 text-center text-sm text-muted">Aucune campagne ne correspond aux filtres.</p>}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((c) => (
                <div key={c.id} className="rounded-xl border border-line p-3 hover:border-violet">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/prospection/campagnes/${c.id}`} className="font-semibold hover:text-violet-strong">{c.name}</Link>
                    <CampaignStatusBadge status={c.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">{c.channels.map((ch) => <ChannelChip key={ch} channel={ch} />)}</div>
                  <div className="mt-2 grid grid-cols-4 gap-1 text-center">
                    {[["Inscrites", c.enrolled], ["Auj.", c.due_today], ["Retard", c.overdue], ["Réponses", c.replied]].map(([l, v]) => (
                      <div key={l as string} className="rounded-md bg-surface py-1">
                        <p className={cn("font-display text-base font-bold tabular-nums", l === "Retard" && (v as number) > 0 && "text-danger")}>{v}</p>
                        <p className="font-label text-[10px] text-muted">{l}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted">
                    <span>{c.interested} intéressée(s) · {c.meetings} RDV</span>
                    <RowActions c={c} act={act} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <CreateCampaign open={createOpen} onClose={() => setCreateOpen(false)} templates={templates} />
    </div>
  );
}

function RowActions({ c, act }: { c: CampaignOverview; act: (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, msg: string, open?: (d: unknown) => string) => void }) {
  return (
    <div className="flex justify-end gap-0.5 opacity-70 group-hover:opacity-100">
      {c.status === "active" && (
        <Button size="sm" variant="ghost" title="Mettre en pause" onClick={() => act(() => setCampaignStatusAction(c.id, "paused"), "Campagne en pause")}><Pause size={13} /></Button>
      )}
      {c.status === "paused" && (
        <Button size="sm" variant="ghost" title="Reprendre" onClick={() => act(() => setCampaignStatusAction(c.id, "active"), "Campagne reprise")}><Play size={13} /></Button>
      )}
      <Button size="sm" variant="ghost" title="Dupliquer (sans les prospects)" onClick={() => act(() => duplicateCampaignAction(c.id), "Campagne dupliquée en brouillon", (d) => `/prospection/campagnes/${d}/sequence`)}><Copy size={13} /></Button>
      {c.status !== "archived" ? (
        <Button size="sm" variant="ghost" title="Archiver" onClick={() => { if (confirm(`Archiver « ${c.name} » ? Ses actions ne seront plus proposées ; l'historique est conservé.`)) act(() => setCampaignStatusAction(c.id, "archived"), "Campagne archivée"); }}><Archive size={13} /></Button>
      ) : (
        <Button size="sm" variant="ghost" title="Désarchiver" onClick={() => act(() => setCampaignStatusAction(c.id, "paused"), "Campagne restaurée (en pause)")}><Play size={13} /></Button>
      )}
    </div>
  );
}

function Th({ k, sort, setSort, children, title, right }: { k: SortKey; sort: { key: SortKey; asc: boolean }; setSort: (s: { key: SortKey; asc: boolean }) => void; children: React.ReactNode; title?: string; right?: boolean }) {
  return (
    <th className={cn("px-3 py-2 font-label text-xs font-semibold text-muted", right && "text-right")} title={title}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : false })}>
        {children}
        {sort.key === k && (sort.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );
}

function CreateCampaign({ open, onClose, templates }: { open: boolean; onClose: () => void; templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const r = await createCampaignAction(name, template || null);
    setPending(false);
    if (!r.ok) return toast.error(r.error);
    onClose();
    router.push(`/prospection/campagnes/${r.data}/sequence`);
  }
  return (
    <Modal open={open} onClose={onClose} title="Créer une campagne">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nom *"><Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Fondateurs SaaS — novembre" /></Field>
        <Field label="Partir d'un modèle" hint="Les étapes sont copiées dans la campagne : le modèle reste indépendant.">
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Séquence vide</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <p className="text-xs text-muted">La campagne est créée en brouillon. Vous construirez la séquence, ajouterez les prospects puis activerez ceux qui sont prêts.</p>
        <div className="flex justify-end"><Button type="submit" variant="primary" disabled={pending || !name.trim()}>Créer et construire la séquence</Button></div>
      </form>
    </Modal>
  );
}
