"use client";

// Tableau des participants : vues, filtres combinables, colonnes masquables et
// redimensionnables, tri, sélection multiple, actions groupées, pagination.
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowUp, Ban, Columns3, Plus, Save, Search, Trash2, X } from "lucide-react";
import { deleteViewAction, saveViewAction, updateParticipantsAction } from "@/app/prospection-actions";
import { useActivation } from "@/components/prospection/activate-dialog";
import { ExecBadge, OutcomeBadge, StepIcon } from "@/components/prospection/bits";
import { EnrollModal } from "@/components/prospection/enroll-modal";
import { ParticipantPanel } from "@/components/prospection/participant-panel";
import { Button, EmptyState, Input, Modal, Select, cn } from "@/components/ui";
import { addDaysISO, personName, relativeDay, todayISO } from "@/lib/format";
import type { CampaignStep, CampaignWorkspace, Outcome, ParticipantRow, ParticipantStatus, SavedView } from "@/lib/prospection/service";
import { STEP_META, variableLabel, NEEDS_LABEL } from "@/lib/prospection/steps";
import { readiness, stepsOf, targetPerson, type Readiness } from "@/lib/prospection/workspace";

type Row = {
  p: ParticipantRow;
  steps: CampaignStep[];
  step: CampaignStep | null;
  person: ReturnType<typeof targetPerson>;
  ready: Readiness;
  conflicts: number;
  last: CampaignWorkspace["lastInteractions"][number] | null;
  late: boolean;
  alerts: string[];
};

type Filters = { exec: ParticipantStatus[]; outcome: Outcome[]; channel: string; due: "" | "late" | "today" | "due"; alerts: boolean; q: string };
type ColKey = "company" | "person" | "channel" | "status" | "step" | "next" | "due" | "last" | "outcome" | "alerts";
type Config = { filters: Filters; hidden: ColKey[]; widths: Partial<Record<ColKey, number>>; sort: { key: ColKey; asc: boolean } };

const EMPTY: Filters = { exec: [], outcome: [], channel: "", due: "", alerts: false, q: "" };

const BUILTIN: { id: string; label: string; filters: Partial<Filters> }[] = [
  { id: "tous", label: "Tous", filters: {} },
  { id: "a_preparer", label: "À préparer", filters: { exec: ["a_preparer"] } },
  { id: "en_cours", label: "En cours", filters: { exec: ["a_contacter", "en_cours"] } },
  { id: "a_relancer", label: "À relancer", filters: { exec: ["a_contacter", "en_cours"], due: "due" } },
  { id: "retard", label: "En retard", filters: { exec: ["a_contacter", "en_cours"], due: "late" } },
  { id: "repondu", label: "A répondu", filters: { outcome: ["replied"] } },
  { id: "interesse", label: "Intéressé", filters: { outcome: ["interested", "meeting"] } },
  { id: "termine", label: "Terminé", filters: { exec: ["termine"] } },
  { id: "bloque", label: "Bloqué", filters: { alerts: true } },
];

const COLUMNS: { key: ColKey; label: string; width: number }[] = [
  { key: "company", label: "Entreprise", width: 170 },
  { key: "person", label: "Personne ciblée", width: 150 },
  { key: "channel", label: "Canal", width: 100 },
  { key: "status", label: "Statut", width: 130 },
  { key: "step", label: "Étape", width: 110 },
  { key: "next", label: "Prochaine action", width: 140 },
  { key: "due", label: "Échéance", width: 95 },
  { key: "last", label: "Dernière interaction", width: 170 },
  { key: "outcome", label: "Résultat", width: 105 },
  { key: "alerts", label: "Alertes", width: 180 },
];

const PAGE = 50;

export function ParticipantsTable({ ws, savedViews, initialView }: { ws: CampaignWorkspace; savedViews: SavedView[]; initialView: string }) {
  const router = useRouter();
  const today = todayISO();
  const builtin = BUILTIN.find((b) => b.id === initialView) ?? BUILTIN[0];
  const [viewId, setViewId] = useState<string>(builtin.id);
  const [cfg, setCfg] = useState<Config>({ filters: { ...EMPTY, ...builtin.filters }, hidden: [], widths: {}, sort: { key: "due", asc: true } });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState<string | null>(null);
  const [colsOpen, setColsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [postponeTo, setPostponeTo] = useState(addDaysISO(today, 2));
  const { activate, busy: activating, dialog } = useActivation(ws.campaign.id, () => setSelected(new Set()));

  const rows: Row[] = useMemo(() => {
    const conflictCount = new Map<string, number>();
    ws.conflicts.forEach((c) => conflictCount.set(c.participant_id, (conflictCount.get(c.participant_id) ?? 0) + 1));
    return ws.participants.map((p) => {
      const steps = stepsOf(ws, p.sequence_version);
      const step = steps.find((s) => s.position === p.current_step) ?? null;
      const person = targetPerson(p, ws.people);
      const conflicts = conflictCount.get(p.id) ?? 0;
      const ready = readiness(p, steps, ws.people, ws.drafts, conflicts);
      const activeOrPrep = ["a_preparer", "a_contacter", "en_cours"].includes(p.status);
      const alerts: string[] = [];
      if (p.company.do_not_contact) alerts.push("Ne plus contacter");
      if (p.company.stage_id && activeOrPrep) alerts.push("Déjà dans un pipeline");
      if (activeOrPrep) {
        if (ready.noPerson) alerts.push("Aucune personne ciblée");
        ready.missingContacts.forEach((m) => alerts.push(`Étape ${m.step} : ${NEEDS_LABEL[m.need as keyof typeof NEEDS_LABEL]} manquant`));
        ready.missingVariables.forEach((m) => alerts.push(`Étape ${m.step} : ${m.variables.map(variableLabel).join(", ")}`));
        if (conflicts) alerts.push(`Sollicité dans ${conflicts} autre(s) campagne(s)`);
      }
      return {
        p, steps, step, person, ready, conflicts,
        last: ws.lastInteractions.find((l) => l.campaign_participant_id === p.id) ?? null,
        late: !!p.next_due_date && p.next_due_date < today && (p.status === "a_contacter" || p.status === "en_cours"),
        alerts,
      };
    });
  }, [ws, today]);

  const f = cfg.filters;
  const filtered = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (f.exec.length && !f.exec.includes(r.p.status)) return false;
      if (f.outcome.length && !f.outcome.includes(r.p.outcome)) return false;
      if (f.channel && r.step?.channel !== f.channel) return false;
      if (f.due === "late" && !r.late) return false;
      if (f.due === "today" && r.p.next_due_date !== today) return false;
      if (f.due === "due" && !(r.p.next_due_date && r.p.next_due_date <= today)) return false;
      if (f.alerts && !(r.alerts.length > 0 || r.p.status === "arrete")) return false;
      if (needle && !`${r.p.company.name} ${r.person ? personName(r.person) : ""} ${r.person?.email ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const val = (r: Row): string | number => {
      switch (cfg.sort.key) {
        case "company": return r.p.company.name.toLowerCase();
        case "person": return r.person ? personName(r.person).toLowerCase() : "~";
        case "channel": return r.step?.channel ?? "~";
        case "status": return r.p.status;
        case "step": return r.p.current_step;
        case "next": return r.step?.name ?? "~";
        case "due": return r.p.next_due_date ?? "9999";
        case "last": return r.last?.occurred_at ?? "";
        case "outcome": return r.p.outcome;
        case "alerts": return -r.alerts.length;
      }
    };
    return out.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * (cfg.sort.asc ? 1 : -1);
    });
  }, [rows, f, cfg.sort, today]);

  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const visible = COLUMNS.filter((c) => !cfg.hidden.includes(c.key));
  const selRows = rows.filter((r) => selected.has(r.p.id));
  const panelRow = rows.find((r) => r.p.id === panel) ?? null;

  function applyView(id: string) {
    setViewId(id);
    setPage(0);
    setSelected(new Set());
    const b = BUILTIN.find((x) => x.id === id);
    if (b) return setCfg((c) => ({ ...c, filters: { ...EMPTY, ...b.filters } }));
    const v = savedViews.find((x) => x.id === id);
    if (v) setCfg({ ...{ filters: EMPTY, hidden: [], widths: {}, sort: { key: "due", asc: true } }, ...(v.config as Partial<Config>) } as Config);
  }
  const setFilters = (patch: Partial<Filters>) => {
    setCfg((c) => ({ ...c, filters: { ...c.filters, ...patch } }));
    setPage(0);
  };
  const countFor = (b: (typeof BUILTIN)[number]) => {
    const ff = { ...EMPTY, ...b.filters };
    return rows.filter((r) =>
      (!ff.exec.length || ff.exec.includes(r.p.status)) &&
      (!ff.outcome.length || ff.outcome.includes(r.p.outcome)) &&
      (ff.due !== "late" || r.late) &&
      (ff.due !== "due" || (r.p.next_due_date && r.p.next_due_date <= today)) &&
      (!ff.alerts || r.alerts.length > 0 || r.p.status === "arrete"),
    ).length;
  };

  // redimensionnement des colonnes
  const drag = useRef<{ key: ColKey; x: number; w: number } | null>(null);
  function startResize(e: React.PointerEvent, key: ColKey, w: number) {
    e.preventDefault();
    drag.current = { key, x: e.clientX, w };
    const move = (ev: PointerEvent) => {
      if (!drag.current) return;
      const width = Math.max(70, drag.current.w + ev.clientX - drag.current.x);
      setCfg((c) => ({ ...c, widths: { ...c.widths, [drag.current!.key]: width } }));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function bulk(action: "postpone" | "stop" | "resume" | "unprepare", label: string, due?: string) {
    const ids = selRows.map((r) => r.p.id);
    const r = await updateParticipantsAction(ids, action, { due, reason: action === "stop" ? "Arrêt groupé" : null });
    if (!r.ok) return toast.error(r.error);
    if (r.data.errors.length) toast.warning(`${r.data.ok} ${label}, ${r.data.errors.length} refusé(s) : ${[...new Set(r.data.errors)].join(" · ")}`);
    else toast.success(`${r.data.ok} participant(s) ${label}`);
    setSelected(new Set());
    router.refresh();
  }

  if (!rows.length) {
    return (
      <>
        <EmptyState
          title="Aucun prospect dans cette campagne"
          description="Ajoutez des listes ou des fiches existantes. Elles arrivent « à préparer » : rien n'est proposé avant leur activation."
          action={<Button variant="primary" onClick={() => setEnrollOpen(true)}><Plus size={15} /> Ajouter des prospects</Button>}
        />
        <EnrollModal campaignId={ws.campaign.id} open={enrollOpen} onClose={() => setEnrollOpen(false)} />
      </>
    );
  }

  return (
    <div>
      {/* Vues */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {BUILTIN.map((b) => (
          <button key={b.id} onClick={() => applyView(b.id)} className={cn("rounded-md px-2 py-1 text-xs font-semibold", viewId === b.id ? "bg-ink text-white" : "text-muted hover:bg-surface hover:text-ink")}>
            {b.label} <span className="font-normal opacity-70">{countFor(b)}</span>
          </button>
        ))}
        {savedViews.map((v) => (
          <span key={v.id} className={cn("flex items-center rounded-md text-xs font-semibold", viewId === v.id ? "bg-violet text-white" : "bg-violet-soft text-violet-strong")}>
            <button onClick={() => applyView(v.id)} className="px-2 py-1">{v.name}</button>
            {viewId === v.id && (
              <button
                className="pr-1.5"
                aria-label="Supprimer la vue"
                onClick={async () => {
                  if (!confirm(`Supprimer la vue « ${v.name} » ?`)) return;
                  const r = await deleteViewAction(v.id);
                  if (!r.ok) return toast.error(r.error);
                  applyView("tous");
                  router.refresh();
                }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </span>
        ))}
        <Button size="sm" variant="ghost" onClick={() => { setViewName(""); setSaveOpen(true); }}><Save size={12} /> Enregistrer la vue</Button>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEnrollOpen(true)}><Plus size={13} /> Ajouter des prospects</Button>
      </div>

      {/* Barre d'outils */}
      <div className="sticky top-[5.75rem] z-20 -mx-1 mb-2 flex flex-wrap items-center gap-1.5 bg-white px-1 py-1.5">
        <div className="relative w-56">
          <Search size={13} className="absolute top-2.5 left-2.5 text-muted" />
          <Input value={f.q} onChange={(e) => setFilters({ q: e.target.value })} placeholder="Entreprise, personne, email" className="h-8 pl-7 text-xs" />
        </div>
        <MultiSelect
          label="Statut"
          options={[["a_preparer", "À préparer"], ["a_contacter", "À contacter"], ["en_cours", "En cours"], ["a_repondu", "A répondu"], ["termine", "Terminé"], ["arrete", "Arrêté"]]}
          value={f.exec}
          onChange={(v) => setFilters({ exec: v as ParticipantStatus[] })}
        />
        <MultiSelect
          label="Résultat"
          options={[["none", "Aucun"], ["replied", "A répondu"], ["interested", "Intéressé"], ["meeting", "Rendez-vous"], ["not_interested", "Pas intéressé"], ["do_not_contact", "Ne plus contacter"]]}
          value={f.outcome}
          onChange={(v) => setFilters({ outcome: v as Outcome[] })}
        />
        <Select value={f.channel} onChange={(e) => setFilters({ channel: e.target.value })} className="h-8 w-auto text-xs" aria-label="Canal courant">
          <option value="">Tous canaux</option>
          <option value="linkedin">LinkedIn</option>
          <option value="email">Email</option>
          <option value="phone">Appel</option>
          <option value="other">Tâche</option>
        </Select>
        <Select value={f.due} onChange={(e) => setFilters({ due: e.target.value as Filters["due"] })} className="h-8 w-auto text-xs" aria-label="Échéance">
          <option value="">Toute échéance</option>
          <option value="due">Dû (≤ aujourd&apos;hui)</option>
          <option value="today">Aujourd&apos;hui</option>
          <option value="late">En retard</option>
        </Select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.alerts} onChange={(e) => setFilters({ alerts: e.target.checked })} /> Avec alertes</label>
        {JSON.stringify(f) !== JSON.stringify(EMPTY) && <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY)}><X size={12} /> Effacer</Button>}
        <span className="ml-auto text-xs text-muted">{filtered.length} / {rows.length}</span>
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setColsOpen((o) => !o)}><Columns3 size={13} /> Colonnes</Button>
          {colsOpen && (
            <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-line bg-white p-1.5 shadow-xl">
              {COLUMNS.filter((c) => c.key !== "company").map((c) => (
                <label key={c.key} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface">
                  <input
                    type="checkbox"
                    checked={!cfg.hidden.includes(c.key)}
                    onChange={(e) => setCfg((x) => ({ ...x, hidden: e.target.checked ? x.hidden.filter((h) => h !== c.key) : [...x.hidden, c.key] }))}
                  />
                  {c.label}
                </label>
              ))}
              <button className="mt-1 w-full rounded px-1.5 py-1 text-left text-xs text-muted hover:bg-surface" onClick={() => setCfg((x) => ({ ...x, widths: {} }))}>Réinitialiser les largeurs</button>
            </div>
          )}
        </div>
      </div>

      {/* Actions groupées */}
      {selected.size > 0 && (
        <div className="sticky top-[8.5rem] z-20 mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-violet-line bg-violet-soft px-3 py-1.5 text-sm">
          <strong>{selected.size} sélectionné(s)</strong>
          {selRows.some((r) => r.p.status === "a_preparer") && (
            <Button size="sm" variant="primary" disabled={activating} onClick={() => activate(selRows.filter((r) => r.p.status === "a_preparer").map((r) => r.p.id))}>
              Activer {selRows.filter((r) => r.p.status === "a_preparer").length}
            </Button>
          )}
          <span className="flex items-center gap-1">
            <Input type="date" value={postponeTo} onChange={(e) => setPostponeTo(e.target.value)} className="h-7 w-36 text-xs" aria-label="Nouvelle échéance" />
            <Button size="sm" onClick={() => bulk("postpone", "reporté(s)", postponeTo)}>Reporter</Button>
          </span>
          <Button size="sm" onClick={() => bulk("resume", "repris")}>Reprendre</Button>
          <Button size="sm" onClick={() => { if (confirm(`Arrêter le suivi de ${selected.size} participant(s) ?`)) bulk("stop", "arrêté(s)"); }}>Arrêter</Button>
          {selRows.some((r) => r.p.status === "a_preparer") && <Button size="sm" variant="ghost" onClick={() => bulk("unprepare", "retiré(s)")}>Retirer</Button>}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Désélectionner</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="text-sm" style={{ tableLayout: "fixed", width: 36 + visible.reduce((s, c) => s + (cfg.widths[c.key] ?? c.width), 0) }}>
          <colgroup>
            <col style={{ width: 36 }} />
            {visible.map((c) => <col key={c.key} style={{ width: cfg.widths[c.key] ?? c.width }} />)}
          </colgroup>
          <thead className="border-b border-line bg-surface text-left">
            <tr>
              <th className="px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={filtered.length > 0 && filtered.every((r) => selected.has(r.p.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.p.id)) : new Set())}
                />
              </th>
              {visible.map((c) => (
                <th key={c.key} className="relative px-2 py-2 font-label text-xs font-semibold text-muted select-none">
                  <button className="inline-flex items-center gap-1 truncate hover:text-ink" onClick={() => setCfg((x) => ({ ...x, sort: { key: c.key, asc: x.sort.key === c.key ? !x.sort.asc : true } }))}>
                    {c.label}
                    {cfg.sort.key === c.key && (cfg.sort.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                  <span onPointerDown={(e) => startResize(e, c.key, cfg.widths[c.key] ?? c.width)} className="absolute top-1 right-0 bottom-1 w-1.5 cursor-col-resize rounded hover:bg-violet-line" aria-hidden />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {pageRows.map((r) => (
              <tr key={r.p.id} onClick={() => setPanel(r.p.id)} className={cn("cursor-pointer hover:bg-violet-soft/40", selected.has(r.p.id) && "bg-violet-soft/60")}>
                <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner ${r.p.company.name}`}
                    checked={selected.has(r.p.id)}
                    onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.p.id)) n.delete(r.p.id); else n.add(r.p.id); return n; })}
                  />
                </td>
                {visible.map((c) => <td key={c.key} className="truncate px-2 py-1.5">{cell(c.key, r, today)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && <p className="p-6 text-center text-sm text-muted">Aucun participant dans cette vue.</p>}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Précédent</Button>
          Page {page + 1} / {pages}
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Suivant</Button>
        </div>
      )}

      {panelRow && (
        <ParticipantPanel
          p={panelRow.p}
          steps={panelRow.steps}
          people={ws.people}
          drafts={ws.drafts}
          conflicts={ws.conflicts.filter((c) => c.participant_id === panelRow.p.id)}
          onClose={() => setPanel(null)}
        />
      )}
      <EnrollModal campaignId={ws.campaign.id} open={enrollOpen} onClose={() => setEnrollOpen(false)} />
      {dialog}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Enregistrer la vue">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await saveViewAction({ scope: "participants", name: viewName, config: cfg as unknown as Record<string, unknown> });
            if (!r.ok) return toast.error(r.error);
            toast.success("Vue enregistrée (filtres, colonnes, largeurs et tri)");
            setSaveOpen(false);
            setViewId(r.data.id);
            router.refresh();
          }}
          className="space-y-3"
        >
          <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Ex. Relances LinkedIn en retard" required />
          <div className="flex justify-end"><Button type="submit" variant="primary">Enregistrer</Button></div>
        </form>
      </Modal>
    </div>
  );
}

function cell(key: ColKey, r: Row, today: string): React.ReactNode {
  const p = r.p;
  switch (key) {
    case "company":
      return (
        <span className="flex items-center gap-1 font-semibold">
          {p.company.do_not_contact && <Ban size={12} className="shrink-0 text-danger" aria-label="Ne plus contacter" />}
          <span className="truncate">{p.company.name}</span>
        </span>
      );
    case "person":
      return r.person ? <span>{personName(r.person)}{r.person.title && <span className="text-muted"> · {r.person.title}</span>}</span> : <span className="text-danger">Non choisie</span>;
    case "channel":
      return r.step && p.status !== "termine" && p.status !== "arrete" ? (
        <span className="flex items-center gap-1.5"><StepIcon type={r.step.step_type} size={11} /><span className="text-xs">{STEP_META[r.step.step_type].short}</span></span>
      ) : <span className="text-muted">—</span>;
    case "status":
      return <ExecBadge status={p.status} />;
    case "step":
      return (
        <span className="flex items-center gap-1.5">
          <span className="font-label text-xs tabular-nums">{Math.min(p.current_step, r.steps.length)}/{r.steps.length}</span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
            <span className="block h-full rounded-full bg-violet" style={{ width: `${(Math.min(p.current_step - 1, r.steps.length) / Math.max(r.steps.length, 1)) * 100}%` }} />
          </span>
        </span>
      );
    case "next":
      return ["a_preparer", "a_contacter", "en_cours"].includes(p.status) && r.step ? <span className="text-xs">{r.step.name}</span> : <span className="text-muted">—</span>;
    case "due":
      return p.next_due_date && (p.status === "a_contacter" || p.status === "en_cours") ? (
        <span className={cn("text-xs", r.late && "font-bold text-danger", p.next_due_date === today && "font-semibold text-violet-strong")}>{relativeDay(p.next_due_date)}</span>
      ) : <span className="text-muted">—</span>;
    case "last":
      return r.last ? (
        <span className="text-xs"><span className="text-muted">{r.last.kind === "message_in" ? "Reçu" : r.last.kind === "call" ? "Appel" : r.last.kind === "message_out" ? "Envoyé" : "Action"} · {relativeDay(r.last.occurred_at)} · </span>{r.last.content}</span>
      ) : <span className="text-muted">—</span>;
    case "outcome":
      return <OutcomeBadge outcome={p.outcome} />;
    case "alerts":
      return r.alerts.length ? (
        <span className="flex items-center gap-1 text-xs text-amber-800" title={r.alerts.join("\n")}><AlertTriangle size={12} className="shrink-0" />{r.alerts[0]}{r.alerts.length > 1 && ` +${r.alerts.length - 1}`}</span>
      ) : <span className="text-muted">—</span>;
  }
}

function MultiSelect({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className={cn("flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs", value.length ? "border-violet bg-violet-soft font-semibold" : "border-line")}>
        {label}{value.length ? ` · ${value.length}` : ""}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} aria-label="Fermer" />
          <div className="absolute z-30 mt-1 w-48 rounded-lg border border-line bg-white p-1.5 shadow-xl">
            {options.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface">
                <input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
                {l}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
