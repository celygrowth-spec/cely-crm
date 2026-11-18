"use client";

// Paramètres › Connecteurs › Carte : Cely Growth au centre, un nœud par connecteur et par client MCP, et les outils
// déclarés à la main (pointillés). Lecture seule, sauf « Ajouter un outil relié » et la suppression d'un outil déclaré.
// Grand écran : carte radiale en SVG. Mobile : arbre vertical, mêmes nœuds, même panneau.
import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  ArrowDown, ArrowLeftRight, ArrowUp, ArrowUpRight, Bot, CalendarDays, CircleHelp, Mail, Mic, Minus, Plus, Puzzle, Search, Send, Sparkles, Trash2, Workflow, X,
} from "lucide-react";
import { addMapToolAction, deleteMapToolAction } from "@/app/carte-actions";
import { Badge, Button, Field, Input, Modal, Select, cn } from "@/components/ui";
import {
  DIRECTION_LABEL, MAP_STATE_LABEL, SIZE, VIEW, buildMap, edgePoint, layout, parentOptions,
  type DeclaredTool, type Direction, type MapIcon, type MapInput, type MapNode, type MapState,
} from "@/lib/connectors/map-model";

const ICON: Record<MapIcon, typeof Mail> = {
  core: Sparkles, gmail: Mail, google_calendar: CalendarDays, fireflies: Mic, claude: Bot, ubersuggest: Search, lemlist: Send, make: Workflow, unknown: CircleHelp, tool: Puzzle,
};
const TONE: Record<MapState, "success" | "danger" | "neutral"> = { connected: "success", reconnect: "danger", not_connected: "neutral" };
const STROKE: Record<MapState | "declared" | "dimmed", string> = {
  connected: "var(--m-ok)", reconnect: "var(--m-warn)", not_connected: "var(--m-off)", declared: "var(--m-decl)", dimmed: "var(--m-off)",
};
const DIR_ICON: Record<Direction, typeof Mail> = { in: ArrowDown, out: ArrowUp, both: ArrowLeftRight, none: Minus, declared: Minus };

const tone = (n: MapNode): keyof typeof STROKE => (n.kind === "declared" ? (n.dimmed ? "dimmed" : "declared") : n.state ?? "not_connected");

const when = (iso: string) => {
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", ...o }).format(d);
  const day = { day: "numeric", month: "short" } as const;
  const time = fmt({ hour: "2-digit", minute: "2-digit" }).replace(":", " h ");
  const now = new Date();
  if (fmt(day) === new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", ...day }).format(now)) return `aujourd'hui à ${time}`;
  if (fmt(day) === new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", ...day }).format(new Date(now.getTime() - 864e5))) return `hier à ${time}`;
  return `le ${fmt({ ...day, year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })} à ${time}`;
};

/** descendants d'un outil déclaré (supprimés avec lui) */
const descendants = (tools: DeclaredTool[], id: string): string[] => {
  const kids = tools.filter((t) => t.parentTool === id).map((t) => t.id);
  return [id, ...kids.flatMap((k) => descendants(tools, k))];
};

export function ConnectorsMap({ initial }: { initial: MapInput }) {
  const [tools, setTools] = useState(initial.tools);
  const nodes = useMemo(() => buildMap({ ...initial, tools }), [initial, tools]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // parent présélectionné
  const current = nodes.find((n) => n.id === selected) ?? null;

  const counts = useMemo(() => {
    const real = nodes.filter((n) => n.state);
    return {
      connected: real.filter((n) => n.state === "connected").length,
      reconnect: real.filter((n) => n.state === "reconnect").length,
      off: real.filter((n) => n.state === "not_connected").length,
      declared: nodes.filter((n) => n.kind === "declared").length,
    };
  }, [nodes]);

  const panelProps = (n: MapNode) => ({
    node: n,
    parent: nodes.find((x) => x.id === n.parent) ?? null,
    onClose: () => setSelected(null),
    onAdd: () => setAdding(n.id),
    onRemove: () => removeTool(n),
    canAddUnder: n.depth <= 2,
  });

  const removeTool = (n: MapNode) => {
    if (!n.toolId) return;
    const kids = descendants(tools, n.toolId).length - 1;
    if (!confirm(`Supprimer « ${n.label} » de la carte ?${kids ? `\n\n${kids} outil(s) relié(s) à lui seront aussi retirés.` : ""}\n\nCela ne touche à rien dans l'outil lui-même.`)) return;
    void deleteMapToolAction(n.toolId).then((r) => {
      if (!r.ok) return void toast.error(r.error);
      const gone = new Set(descendants(tools, n.toolId!));
      setTools((t) => t.filter((x) => !gone.has(x.id)));
      setSelected(null);
      toast.success(`« ${n.label} » retiré de la carte`);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" data-map-summary>
          <span className="font-semibold text-success">{counts.connected} connecté{counts.connected > 1 ? "s" : ""}</span>
          {counts.reconnect > 0 && <> · <span className="font-semibold text-danger">{counts.reconnect} à reconnecter</span></>}
          {` · ${counts.off} non connecté${counts.off > 1 ? "s" : ""}`}
          {counts.declared > 0 && ` · ${counts.declared} déclaré${counts.declared > 1 ? "s" : ""}`}
        </p>
        <Button size="sm" onClick={() => setAdding("core")} data-add-tool><Plus size={14} /> Ajouter un outil relié</Button>
      </div>

      <div className="cmap relative overflow-hidden rounded-2xl border border-line" data-connector-map>
        <style href="cmap-styles" precedence="default">{CMAP_CSS}</style>
        <RadialMap nodes={nodes} selected={selected} onSelect={setSelected} />
        <TreeMap nodes={nodes} selected={selected} onSelect={setSelected} />
        <Legend />
        {current && (
          <div className="hidden md:block">
            <NodePanel {...panelProps(current)} className="absolute top-3 right-3 max-h-[calc(100%-1.5rem)] w-80 rounded-2xl" />
          </div>
        )}
      </div>
      {/* mobile : feuille en bas d'écran, rendue hors de la page pour passer au-dessus de la barre de navigation */}
      {current && typeof document !== "undefined" && createPortal(
        <div className="cmap md:hidden">
          <button type="button" aria-label="Fermer le détail" className="fixed inset-0 z-50 bg-ink/30" onClick={() => setSelected(null)} />
          <NodePanel {...panelProps(current)} className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+1.25rem)]" />
        </div>,
        document.body,
      )}

      <p className="text-xs text-muted">
        La carte montre ce que le CRM enregistre lui-même. Ce qui passe par un intermédiaire (un scénario Make vers Tiime, un outil branché seulement sur Claude…) lui est invisible : déclarez-le pour le voir ici. Un lien animé a été actif dans les dernières 24 heures.
      </p>

      <AddToolModal
        open={adding !== null}
        initialParent={adding ?? "core"}
        options={parentOptions(nodes)}
        onClose={() => setAdding(null)}
        onAdded={(t, existed) => {
          setAdding(null);
          if (existed) toast.info(`« ${t.name} » est déjà déclaré à cet endroit.`);
          else toast.success(`« ${t.name} » ajouté à la carte`);
          setTools((list) => (list.some((x) => x.id === t.id) ? list : [...list, t]));
          setSelected(`tool:${t.id}`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Carte radiale (md et plus)
// ---------------------------------------------------------------------------

function RadialMap({ nodes, selected, onSelect }: { nodes: MapNode[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const pos = useMemo(() => layout(nodes), [nodes]);
  const half = (n: MapNode) => (n.kind === "core" ? { w: SIZE.core.w / 2, h: SIZE.core.h / 2 } : { w: SIZE.node.w / 2, h: SIZE.node.h / 2 });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} className="hidden h-auto w-full select-none md:block" role="group" aria-label="Carte des connecteurs" onClick={() => onSelect(null)}>
      <defs>
        <pattern id="cmap-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--m-grid)" /></pattern>
        {(Object.keys(STROKE) as (keyof typeof STROKE)[]).map((k) => (
          <marker key={k} id={`cmap-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={STROKE[k]} />
          </marker>
        ))}
        <filter id="cmap-shadow" x="-20%" y="-30%" width="140%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="var(--m-shadow)" /></filter>
      </defs>
      <rect width={VIEW.w} height={VIEW.h} fill="url(#cmap-grid)" />

      {nodes.filter((n) => n.parent).map((n) => {
        const p = byId.get(n.parent!)!;
        const a = pos.get(p.id)!, b = pos.get(n.id)!;
        const from = edgePoint(a, b, { w: half(p).w + 4, h: half(p).h + 4 });
        const to = edgePoint(b, a, { w: half(n).w + 4, h: half(n).h + 4 });
        const t = tone(n);
        const d = `M${from.x} ${from.y} L${to.x} ${to.y}`;
        const arrowStart = n.direction === "in" || n.direction === "both";
        const arrowEnd = n.direction === "out" || n.direction === "both";
        const dashed = n.kind === "declared" || n.direction === "none" || n.state === "not_connected";
        return (
          <g key={`e-${n.id}`} data-edge={n.id} data-direction={n.direction} data-live={n.live || undefined}>
            <path d={d} stroke={STROKE[t]} strokeWidth={n.state === "connected" ? 2 : 1.5} fill="none" opacity={t === "dimmed" || t === "not_connected" ? 0.55 : 0.9}
              strokeDasharray={dashed ? "5 5" : undefined}
              markerStart={arrowStart ? `url(#cmap-arrow-${t})` : undefined} markerEnd={arrowEnd ? `url(#cmap-arrow-${t})` : undefined} />
            {n.live && (
              <path d={d} stroke={STROKE[t]} strokeWidth={4} strokeLinecap="round" fill="none" opacity={0.9}
                className={n.direction === "in" ? "cmap-flow-rev" : n.direction === "out" ? "cmap-flow" : "cmap-flow-both"} />
            )}
          </g>
        );
      })}

      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        const h = half(n);
        const Icon = ICON[n.icon];
        const isCore = n.kind === "core";
        const t = tone(n);
        const open = () => onSelect(n.id === selected ? null : n.id);
        return (
          <g key={n.id} transform={`translate(${p.x - h.w} ${p.y - h.h})`} className={cn("cmap-node", n.id === selected && "cmap-sel")} role="button" tabIndex={0}
            aria-label={`${n.label}${n.state ? `, ${MAP_STATE_LABEL[n.state]}` : n.kind === "declared" ? ", déclaré" : ""}`} aria-pressed={n.id === selected}
            data-node={n.id} data-state={n.state ?? (n.kind === "declared" ? "declared" : "core")}
            onClick={(e) => { e.stopPropagation(); open(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } if (e.key === "Escape") onSelect(null); }}>
            <rect className={"cmap-box"} width={h.w * 2} height={h.h * 2} rx={isCore ? 20 : 14}
              fill={isCore ? "var(--m-core)" : "var(--m-node)"} stroke={isCore ? "var(--m-core)" : n.kind === "declared" ? STROKE[t] : "var(--m-node-line)"}
              strokeDasharray={n.kind === "declared" ? "5 4" : undefined} strokeWidth={1.5} filter="url(#cmap-shadow)" opacity={n.dimmed ? 0.7 : 1} />
            {!isCore && <rect x={0} y={10} width={4} height={h.h * 2 - 20} rx={2} fill={STROKE[t]} />}
            <circle cx={isCore ? 30 : 26} cy={h.h} r={isCore ? 17 : 15} fill={isCore ? "rgb(255 255 255 / 0.16)" : "var(--m-bg)"} />
            <Icon x={isCore ? 20 : 17} y={h.h - (isCore ? 10 : 9)} width={isCore ? 20 : 18} height={isCore ? 20 : 18} color={isCore ? "var(--m-core-ink)" : n.kind === "declared" ? "var(--m-decl)" : "var(--m-ink)"} aria-hidden />
            <text x={isCore ? 56 : 48} y={h.h - (n.sublabel || !isCore ? 3 : -5)} fontSize={isCore ? 16 : 13} fontWeight={700} fill={isCore ? "var(--m-core-ink)" : "var(--m-ink)"}>{clip(n.label, isCore ? 16 : 19)}</text>
            <text x={isCore ? 56 : 48} y={h.h + 14} fontSize={11} fill={isCore ? "rgb(255 255 255 / 0.75)" : n.kind === "declared" ? "var(--m-decl)" : STROKE[t]} fontWeight={600}>
              {isCore ? "Votre CRM" : n.kind === "declared" ? "Déclaré" : MAP_STATE_LABEL[n.state!]}
            </text>
            {n.live && <circle className={"cmap-pulse"} cx={h.w * 2 - 12} cy={12} r={4} fill="var(--m-ok)"><title>Actif dans les dernières 24 h</title></circle>}
          </g>
        );
      })}
    </svg>
  );
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// ---------------------------------------------------------------------------
// Arbre (mobile)
// ---------------------------------------------------------------------------

function TreeMap({ nodes, selected, onSelect }: { nodes: MapNode[]; selected: string | null; onSelect: (id: string) => void }) {
  const core = nodes[0];
  const kids = (id: string) => nodes.filter((n) => n.parent === id);
  const Row = ({ n }: { n: MapNode }) => {
    const Icon = ICON[n.icon];
    const Dir = DIR_ICON[n.direction];
    const t = tone(n);
    return (
      <li className="relative">
        <span aria-hidden className="absolute top-6 -left-4 h-px w-4" style={{ background: STROKE[t], opacity: n.dimmed ? 0.5 : 1 }} />
        <button type="button" onClick={() => onSelect(n.id)} data-node={n.id} data-state={n.state ?? "declared"} aria-pressed={n.id === selected}
          className={cn("flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left", n.id === selected && "ring-2 ring-[var(--m-accent)]", n.dimmed && "opacity-70")}
          style={{ background: "var(--m-node)", borderColor: n.kind === "declared" ? STROKE[t] : "var(--m-node-line)", borderStyle: n.kind === "declared" ? "dashed" : "solid" }}>
          <span className="grid size-8 shrink-0 place-items-center rounded-full" style={{ background: "var(--m-bg)" }}><Icon size={16} color={n.kind === "declared" ? "var(--m-decl)" : "var(--m-ink)"} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold" style={{ color: "var(--m-ink)" }}>{n.label}</span>
            <span className="block truncate text-xs font-semibold" style={{ color: n.kind === "declared" ? "var(--m-decl)" : STROKE[t] }}>{n.kind === "declared" ? "Déclaré" : MAP_STATE_LABEL[n.state!]}</span>
          </span>
          {n.live && <span className={cn("cmap-pulse", "size-2 rounded-full")} style={{ background: "var(--m-ok)" }} aria-label="Actif dans les dernières 24 h" />}
          <Dir size={15} color="var(--m-muted)" aria-label={DIRECTION_LABEL[n.direction]} />
        </button>
        {kids(n.id).length > 0 && (
          <ul className="mt-2 ml-5 space-y-2 border-l border-dashed pl-4" style={{ borderColor: "var(--m-decl)" }}>{kids(n.id).map((k) => <Row key={k.id} n={k} />)}</ul>
        )}
      </li>
    );
  };
  return (
    <div className="p-4 md:hidden">
      <div className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ background: "var(--m-core)", color: "var(--m-core-ink)" }}>
        <Sparkles size={18} /><span className="font-display text-base font-extrabold">{core.label}</span><span className="text-xs opacity-75">Votre CRM</span>
      </div>
      <ul className="mt-2 ml-4 space-y-2 border-l pt-2 pl-4" style={{ borderColor: "var(--m-node-line)" }}>{kids("core").map((n) => <Row key={n.id} n={n} />)}</ul>
    </div>
  );
}

function Legend() {
  const item = (color: string, label: string, dashed = false) => (
    <span className="inline-flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} /></svg>{label}</span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2.5 text-[11px] font-semibold" style={{ borderColor: "var(--m-node-line)", color: "var(--m-muted)" }}>
      {item("var(--m-ok)", "Connecté")}
      {item("var(--m-warn)", "À reconnecter")}
      {item("var(--m-off)", "Non connecté", true)}
      {item("var(--m-decl)", "Déclaré", true)}
      <span className="inline-flex items-center gap-1"><ArrowDown size={12} /> vers le CRM · <ArrowUp size={12} /> depuis le CRM · <ArrowLeftRight size={12} /> les deux</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panneau d'un nœud
// ---------------------------------------------------------------------------

function NodePanel({ node: n, parent, onClose, onAdd, onRemove, canAddUnder, className }: {
  node: MapNode; parent: MapNode | null; onClose: () => void; onAdd: () => void; onRemove: () => void; canAddUnder: boolean; className: string;
}) {
  const Icon = ICON[n.icon];
  const Dir = DIR_ICON[n.direction];
  return (
    <aside className={cn("pop-in overflow-y-auto border border-[var(--m-node-line)] bg-[var(--m-node)] p-5 text-[var(--m-ink)] shadow-xl", className)}
      aria-label={`Détail : ${n.label}`} data-node-panel={n.id}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--m-bg)] text-[var(--m-accent)]"><Icon size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg leading-tight font-bold">{n.label}</h2>
          {n.sublabel && <p className="truncate text-xs text-[var(--m-muted)]">{n.sublabel}</p>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-[var(--m-muted)] hover:bg-[var(--m-bg)]" aria-label="Fermer"><X size={18} /></button>
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="font-label text-[11px] font-bold tracking-wide text-[var(--m-muted)] uppercase">État</dt>
          <dd className="mt-1">
            {n.kind === "core" ? <span>Le CRM lui-même</span> : n.kind === "declared" ? (
              <><Badge tone="violet">Déclaré</Badge><p className="mt-1 text-xs text-[var(--m-muted)]">Ajouté à la main : le CRM ne peut pas vérifier son état.{n.dimmed ? " Un outil en amont n'est pas connecté." : ""}</p></>
            ) : (
              <><Badge tone={TONE[n.state!]}>{MAP_STATE_LABEL[n.state!]}</Badge>{n.detail && <p className="mt-1 text-xs text-[var(--m-muted)]">{n.detail}</p>}</>
            )}
          </dd>
        </div>
        {n.kind !== "core" && (
          <>
            <div>
              <dt className="font-label text-[11px] font-bold tracking-wide text-[var(--m-muted)] uppercase">Dernière activité</dt>
              <dd className="mt-1" data-last-activity>{n.lastActivity ? <>{n.lastActivity.label} {when(n.lastActivity.at)}</> : n.kind === "declared" ? "Invisible pour le CRM" : "Aucune connue"}</dd>
            </div>
            <div>
              <dt className="font-label text-[11px] font-bold tracking-wide text-[var(--m-muted)] uppercase">Sens des échanges</dt>
              <dd className="mt-1 flex items-center gap-1.5"><Dir size={14} className="text-[var(--m-muted)]" />{DIRECTION_LABEL[n.direction]}{n.kind === "declared" && parent ? ` (relié à ${parent.label})` : ""}</dd>
            </div>
          </>
        )}
        {n.feeds.length > 0 && (
          <div>
            <dt className="font-label text-[11px] font-bold tracking-wide text-[var(--m-muted)] uppercase">Ce qui transite</dt>
            <dd className="mt-1"><ul className="list-disc space-y-0.5 pl-4 text-xs text-[var(--m-muted)]">{n.feeds.map((f) => <li key={f}>{f}</li>)}</ul></dd>
          </div>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap gap-2">
        {n.href && <Link href={n.href} className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--m-accent)] hover:underline">Régler ce connecteur <ArrowUpRight size={13} /></Link>}
        {canAddUnder && <Button size="sm" variant="ghost" onClick={onAdd}><Plus size={13} /> Outil relié</Button>}
        {n.kind === "declared" && <Button size="sm" variant="danger" onClick={onRemove}><Trash2 size={13} /> Supprimer</Button>}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Ajouter un outil relié
// ---------------------------------------------------------------------------

function AddToolModal({ open, initialParent, options, onClose, onAdded }: {
  open: boolean; initialParent: string; options: { id: string; label: string }[]; onClose: () => void; onAdded: (t: DeclaredTool, existed: boolean) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Ajouter un outil relié">
      {open && <AddToolForm key={initialParent} initialParent={initialParent} options={options} onAdded={onAdded} onCancel={onClose} />}
    </Modal>
  );
}

function AddToolForm({ initialParent, options, onAdded, onCancel }: { initialParent: string; options: { id: string; label: string }[]; onAdded: (t: DeclaredTool, existed: boolean) => void; onCancel: () => void }) {
  const [parent, setParent] = useState(options.some((o) => o.id === initialParent) ? initialParent : "core");
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const inflight = useRef(false); // un double clic part avant le nouveau rendu : on bloque dès le premier envoi
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inflight.current || !name.trim()) return;
    inflight.current = true;
    start(async () => {
      const r = await addMapToolAction(parent, name);
      inflight.current = false;
      if (!r.ok) return void toast.error(r.error);
      onAdded(r.data.tool, r.data.existed);
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4" data-add-tool-form>
      <p className="text-sm text-muted">Pour un outil que le CRM ne voit pas, parce qu&apos;il passe par un intermédiaire (par exemple Tiime derrière un scénario Make). Il s&apos;affiche en pointillés, sans état.</p>
      <Field label="Relié à">
        <Select value={parent} onChange={(e) => setParent(e.target.value)} name="parent">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
      </Field>
      <Field label="Nom de l'outil">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Tiime, Make, Notion…" name="name" autoComplete="off" required />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending || !name.trim()} data-add-submit>{pending ? "Ajout…" : "Ajouter"}</Button>
      </div>
    </form>
  );
}

// Styles de la carte : jetons clair / sombre et animations (préfixe cmap-, propres à ce composant).
const CMAP_CSS = `
.cmap {
  --m-bg: #fbf9ff;
  --m-grid: #ece5f8;
  --m-node: #ffffff;
  --m-node-line: #ddd3f0;
  --m-ink: #1a1128;
  --m-muted: #6b6178;
  --m-ok: #1f9d5c;
  --m-warn: #c2452f;
  --m-off: #a79fb4;
  --m-decl: #8b5bff;
  --m-accent: #682dfe;
  --m-core: #1a1128;
  --m-core-ink: #ffffff;
  --m-shadow: rgb(26 17 40 / 0.07);
  background: var(--m-bg);
  color: var(--m-ink);
}

@media (prefers-color-scheme: dark) {
  .cmap {
    --m-bg: #130d1d;
    --m-grid: #231a33;
    --m-node: #1e1630;
    --m-node-line: #3a2f52;
    --m-ink: #f1ecfa;
    --m-muted: #a99fbd;
    --m-ok: #45d08e;
    --m-warn: #ff8a73;
    --m-off: #6c6382;
    --m-decl: #a98bff;
    --m-accent: #b49cff;
    --m-core: #8b5bff;
    --m-core-ink: #ffffff;
    --m-shadow: rgb(0 0 0 / 0.35);
  }
}

.cmap-flow {
  stroke-dasharray: 3 11;
  animation: cmap-flow 1.6s linear infinite;
}
.cmap-flow-rev {
  stroke-dasharray: 3 11;
  animation: cmap-flow-rev 1.6s linear infinite;
}
.cmap-flow-both {
  stroke-dasharray: 3 11;
  animation: cmap-flow 1.6s linear infinite alternate;
}
.cmap-pulse {
  animation: cmap-pulse 2s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
}

@keyframes cmap-flow { to { stroke-dashoffset: -28; } }
@keyframes cmap-flow-rev { to { stroke-dashoffset: 28; } }
@keyframes cmap-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(1.35); } }

@media (prefers-reduced-motion: reduce) {
  .cmap-flow, .cmap-flow-rev, .cmap-flow-both, .cmap-pulse { animation: none; }
}

.cmap-node { cursor: pointer; outline: none; }
.cmap-node:focus-visible .cmap-box, .cmap-node:hover .cmap-box { stroke: var(--m-accent); stroke-width: 2; }
.cmap-sel .cmap-box { stroke: var(--m-accent); stroke-width: 2.5; }
`;
