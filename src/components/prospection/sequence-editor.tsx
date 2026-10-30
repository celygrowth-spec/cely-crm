"use client";

// Constructeur visuel de séquence linéaire : blocs connectés au centre, configuration du bloc
// sélectionné à droite, barre d'actions en haut. Partagé par les campagnes et les modèles.
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDown, ArrowUp, Braces, Check, Clock, Copy, Eye, Flag, GripVertical, Minus, Plus, Save, Trash2, X,
} from "lucide-react";
import {
  STEP_META, STEP_TYPES, VARIABLES, cumulativeDays, renderTemplate, unknownVariables, usedVariables, variableLabel,
  type SequenceStep, type StepType, type VariableContext,
} from "@/lib/prospection/steps";
import { Badge, Button, Field, Input, Select, Spinner, Textarea, cn } from "../ui";
import { StepIcon } from "./bits";

type EditorStep = SequenceStep & { uid: string };
export type PreviewContact = { id: string; label: string; ctx: VariableContext };

const uid = () => Math.random().toString(36).slice(2, 10);
const toEditor = (s: SequenceStep): EditorStep => ({ ...s, subject: s.subject ?? "", message: s.message ?? "", instructions: s.instructions ?? "", uid: uid() });
const strip = (s: EditorStep): SequenceStep => ({
  name: s.name.trim(),
  step_type: s.step_type,
  delay_days: s.delay_days,
  subject: STEP_META[s.step_type].hasSubject ? s.subject || null : null,
  message: STEP_META[s.step_type].hasMessage ? s.message || null : null,
  instructions: s.instructions || null,
});

const DEFAULT_TITLE: Record<StepType, string> = {
  linkedin_invite: "Invitation LinkedIn",
  linkedin_message: "Message LinkedIn",
  email: "Email",
  call: "Appel",
  linkedin_visit: "Visite du profil",
  linkedin_interaction: "Interaction LinkedIn",
  task: "Tâche",
};

export function stepWarnings(s: SequenceStep, index: number): string[] {
  const m = STEP_META[s.step_type];
  const w: string[] = [];
  if (m.messageRequired && !(s.message ?? "").trim()) w.push("Message vide");
  if (m.hasSubject && !(s.subject ?? "").trim()) w.push("Objet manquant");
  const unknown = unknownVariables(`${s.subject ?? ""} ${s.message ?? ""}`);
  if (unknown.length) w.push(`Variable inconnue : ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
  if (s.step_type === "linkedin_invite" && (s.message ?? "").length > 300) w.push("Note d'invitation > 300 caractères");
  if (index > 0 && s.delay_days === 0) w.push("Même jour que l'étape précédente");
  return w;
}

export function SequenceEditor({
  title,
  status,
  initialName,
  initialSteps,
  startedOnCurrent = 0,
  version,
  previewContacts = [],
  onSave,
  onSaveAsTemplate,
  extraActions,
  stickyTop = "top-0",
}: {
  title?: string;
  status?: React.ReactNode;
  initialName: string;
  initialSteps: SequenceStep[];
  startedOnCurrent?: number;
  version?: number;
  previewContacts?: PreviewContact[];
  onSave: (name: string, steps: SequenceStep[]) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>;
  onSaveAsTemplate?: (steps: SequenceStep[]) => Promise<void>;
  extraActions?: React.ReactNode;
  stickyTop?: string;
}) {
  const [name, setName] = useState(initialName);
  const [steps, setSteps] = useState<EditorStep[]>(() => initialSteps.map(toEditor));
  const [selected, setSelected] = useState<string | null>(() => null);
  const [saving, setSaving] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify([initialName, initialSteps.map((s) => strip(toEditor(s)))]));
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<string>(previewContacts[0]?.id ?? "");
  const [compact, setCompact] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const snapshot = JSON.stringify([name, steps.map(strip)]);
  const dirty = snapshot !== savedSnapshot;
  const sel = steps.find((s) => s.uid === selected) ?? null;
  const selIndex = sel ? steps.indexOf(sel) : -1;
  const preview = previewContacts.find((c) => c.id === previewId) ?? null;
  const cumul = cumulativeDays(steps);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // structure (types, ordre, délais) modifiée alors que des participants ont démarré → nouvelle version
  const initialSig = useMemo(() => initialSteps.map((s) => `${s.step_type}:${s.delay_days}`).join("|"), [initialSteps]);
  const structural = steps.map((s) => `${s.step_type}:${s.delay_days}`).join("|") !== initialSig;
  const willVersion = startedOnCurrent > 0 && structural;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  function update(u: string, patch: Partial<EditorStep>) {
    setSteps((ss) => ss.map((s) => (s.uid === u ? { ...s, ...patch } : s)));
  }
  function insert(index: number, type: StepType) {
    const s: EditorStep = { uid: uid(), name: DEFAULT_TITLE[type], step_type: type, delay_days: index === 0 ? 0 : 3, subject: "", message: "", instructions: "" };
    setSteps((ss) => [...ss.slice(0, index), s, ...ss.slice(index)]);
    setSelected(s.uid);
    setInsertAt(null);
  }
  function duplicate(u: string) {
    const i = steps.findIndex((s) => s.uid === u);
    const copy = { ...steps[i], uid: uid(), name: `${steps[i].name} (copie)` };
    setSteps((ss) => [...ss.slice(0, i + 1), copy, ...ss.slice(i + 1)]);
    setSelected(copy.uid);
  }
  function move(u: string, d: -1 | 1) {
    const i = steps.findIndex((s) => s.uid === u);
    if (i + d < 0 || i + d >= steps.length) return;
    setSteps((ss) => arrayMove(ss, i, i + d));
  }
  function remove(u: string) {
    setSteps((ss) => ss.filter((s) => s.uid !== u));
    if (selected === u) setSelected(null);
    setConfirmDelete(null);
  }
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = steps.findIndex((s) => s.uid === e.active.id);
    const to = steps.findIndex((s) => s.uid === e.over!.id);
    setSteps((ss) => arrayMove(ss, from, to));
  }

  async function save() {
    if (!steps.length) return toast.error("Ajoutez au moins une étape.");
    const empty = steps.findIndex((s) => !s.name.trim());
    if (empty >= 0) {
      setSelected(steps[empty].uid);
      return toast.error(`Étape ${empty + 1} : le titre est obligatoire.`);
    }
    setSaving(true);
    const res = await onSave(name, steps.map(strip));
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    setSavedSnapshot(snapshot);
    toast.success(res.message ?? "Séquence enregistrée");
  }

  const totalDays = cumul[cumul.length - 1] ?? 0;
  const warnCount = steps.reduce((n, s, i) => n + stepWarnings(s, i).length, 0);

  return (
    <div className="flex min-h-[calc(100dvh-9rem)] flex-col">
      {/* Barre supérieure */}
      <div className={cn("sticky z-20 -mx-4 mb-3 flex flex-wrap items-center gap-2 border-b border-line bg-white/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8", stickyTop)}>
        {title && <span className="font-label text-xs font-bold text-muted uppercase">{title}</span>}
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom" className="h-8 max-w-xs font-semibold" />
        {status}
        {version != null && <Badge>v{version}</Badge>}
        <span className="text-xs text-muted">
          {steps.length} étape(s) · {totalDays} j au total
          {warnCount > 0 && <span className="ml-1 text-warning">· {warnCount} avertissement(s)</span>}
        </span>
        <span className={cn("ml-auto flex items-center gap-1 text-xs", dirty ? "text-warning" : "text-muted")}>
          {saving ? <><Spinner /> Enregistrement…</> : dirty ? "Modifications non enregistrées" : <><Check size={13} /> Enregistré</>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setCompact((c) => !c)} title="Densité d'affichage">
          {compact ? <Plus size={13} /> : <Minus size={13} />} {compact ? "Détaillé" : "Compact"}
        </Button>
        {onSaveAsTemplate && (
          <Button size="sm" onClick={() => onSaveAsTemplate(steps.map(strip))} disabled={!steps.length}>Enregistrer comme modèle</Button>
        )}
        {extraActions}
        <Button size="sm" variant="primary" onClick={save} disabled={saving || !dirty}><Save size={13} /> Enregistrer</Button>
      </div>

      {willVersion && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <p>
            Changement de structure : l&apos;enregistrement créera la <strong>version {(version ?? 1) + 1}</strong>. Les {startedOnCurrent} participant(s) déjà
            démarré(s) poursuivent la version {version ?? 1}, sans réinitialisation ; les participants à préparer passent à la nouvelle version.
          </p>
        </div>
      )}

      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Canevas */}
        <div className="rounded-xl border border-line bg-surface bg-[radial-gradient(circle,#ddd3f0_1px,transparent_1px)] [background-size:18px_18px] px-3 py-5">
          <div className="mx-auto flex max-w-xl flex-col items-center">
            <div className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-muted shadow-xs">
              <Flag size={12} className="text-violet" /> Départ : activation du participant
            </div>
            <InsertPoint open={insertAt === 0} onToggle={() => setInsertAt(insertAt === 0 ? null : 0)} onPick={(t) => insert(0, t)} label={steps.length ? null : "Ajouter la première étape"} />
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={steps.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
                {steps.map((s, i) => (
                  <div key={s.uid} className="flex w-full flex-col items-center">
                    {i > 0 && <DelayPill days={s.delay_days} cumul={cumul[i]} onChange={(d) => update(s.uid, { delay_days: d })} />}
                    {i === 0 && s.delay_days > 0 && <DelayPill days={s.delay_days} cumul={cumul[i]} onChange={(d) => update(s.uid, { delay_days: d })} first />}
                    <StepBlock
                      step={s}
                      index={i}
                      count={steps.length}
                      selected={selected === s.uid}
                      compact={compact}
                      preview={preview}
                      onSelect={() => setSelected(s.uid)}
                      onMove={(d) => move(s.uid, d)}
                    />
                    <InsertPoint open={insertAt === i + 1} onToggle={() => setInsertAt(insertAt === i + 1 ? null : i + 1)} onPick={(t) => insert(i + 1, t)} />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
            <StopRules />
          </div>
        </div>

        {/* Panneau de configuration */}
        <aside className="lg:sticky lg:top-36 lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto">
          {sel ? (
            <StepPanel
              key={sel.uid}
              step={sel}
              index={selIndex}
              count={steps.length}
              preview={preview}
              previewContacts={previewContacts}
              previewId={previewId}
              setPreviewId={setPreviewId}
              onChange={(patch) => update(sel.uid, patch)}
              onClose={() => setSelected(null)}
              onDuplicate={() => duplicate(sel.uid)}
              onMove={(d) => move(sel.uid, d)}
              confirmDelete={confirmDelete === sel.uid}
              onAskDelete={() => setConfirmDelete(sel.uid)}
              onCancelDelete={() => setConfirmDelete(null)}
              onDelete={() => remove(sel.uid)}
              startedOnCurrent={startedOnCurrent}
            />
          ) : (
            <div className="rounded-xl border border-line bg-white p-4 text-sm">
              <p className="font-display text-base font-bold">Configuration</p>
              <p className="mt-1 text-muted">Sélectionnez un bloc pour modifier son canal, son délai, son message et ses consignes internes.</p>
              {previewContacts.length > 0 && (
                <Field label="Aperçu avec un vrai contact" className="mt-4">
                  <Select value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                    {previewContacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </Select>
                </Field>
              )}
              <ul className="mt-4 space-y-1 text-xs text-muted">
                <li>· Glissez la poignée <GripVertical size={11} className="inline" /> pour réordonner, ou utilisez ↑ ↓.</li>
                <li>· Le bouton + entre deux blocs insère une étape à cet endroit.</li>
                <li>· Chaque délai part de la date réelle de réalisation de l&apos;étape précédente.</li>
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function DelayPill({ days, cumul, onChange, first }: { days: number; cumul: number; onChange: (d: number) => void; first?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <div className="h-3 w-px bg-violet-line" />
      <div className="flex items-center gap-1 rounded-full border border-line bg-white px-1 py-0.5 text-xs shadow-xs">
        <Clock size={12} className="ml-1 text-muted" />
        <button className="rounded px-1 text-muted hover:bg-surface" onClick={() => onChange(Math.max(0, days - 1))} aria-label="Réduire le délai">−</button>
        <span className="min-w-20 text-center font-semibold">
          {first ? "Attendre " : days === 0 ? "Le même jour" : "Attendre "}
          {days > 0 && `${days} j`}
        </span>
        <button className="rounded px-1 text-muted hover:bg-surface" onClick={() => onChange(Math.min(365, days + 1))} aria-label="Augmenter le délai">+</button>
        <span className="mr-1 font-label text-[10px] text-muted">J+{cumul}</span>
      </div>
      <div className="h-3 w-px bg-violet-line" />
    </div>
  );
}

function InsertPoint({ open, onToggle, onPick, label }: { open: boolean; onToggle: () => void; onPick: (t: StepType) => void; label?: string | null }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-3 w-px bg-violet-line" />
      <button
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1 rounded-full border bg-white text-xs font-semibold transition-colors",
          label ? "border-violet px-3 py-1.5 text-violet-strong" : "size-6 justify-center border-line text-muted hover:border-violet hover:text-violet-strong",
          open && "border-violet bg-violet-soft text-violet-strong",
        )}
        aria-label="Insérer une étape ici"
      >
        <Plus size={13} /> {label}
      </button>
      {open && (
        <div className="absolute top-full z-30 mt-1 grid w-72 grid-cols-1 gap-0.5 rounded-xl border border-line bg-white p-1.5 shadow-xl">
          {STEP_TYPES.map((t) => (
            <button key={t} onClick={() => onPick(t)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-violet-soft">
              <StepIcon type={t} size={13} />
              {STEP_META[t].label}
            </button>
          ))}
        </div>
      )}
      <div className="h-3 w-px bg-violet-line" />
    </div>
  );
}

function StepBlock({
  step: s, index, count, selected, compact, preview, onSelect, onMove,
}: {
  step: EditorStep; index: number; count: number; selected: boolean; compact: boolean; preview: PreviewContact | null;
  onSelect: () => void; onMove: (d: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.uid });
  const meta = STEP_META[s.step_type];
  const warnings = stepWarnings(s, index);
  const vars = usedVariables(`${s.subject ?? ""} ${s.message ?? ""}`);
  const excerpt = meta.hasMessage
    ? (preview ? renderTemplate(s.message, preview.ctx).text : s.message) || (meta.messageRequired ? "" : "Sans note")
    : s.instructions || "Consigne à définir";
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group w-full rounded-xl border bg-white shadow-xs transition-shadow",
        selected ? "border-violet ring-2 ring-violet/25" : "border-line hover:border-violet-line hover:shadow-sm",
        isDragging && "z-10 shadow-lg",
      )}
    >
      <div className="flex items-start gap-2 p-2.5">
        <button {...attributes} {...listeners} className="mt-1 cursor-grab rounded p-0.5 text-muted hover:bg-surface active:cursor-grabbing" aria-label={`Déplacer l'étape ${index + 1}`}>
          <GripVertical size={14} />
        </button>
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="font-label text-[11px] font-bold text-muted">{index + 1}</span>
            <StepIcon type={s.step_type} size={13} />
            <span className="truncate font-semibold">{s.name || <span className="text-danger">Sans titre</span>}</span>
            <span className="ml-auto shrink-0 font-label text-[10px] text-muted uppercase">{meta.label}</span>
          </div>
          {!compact && (
            <>
              {meta.hasSubject && s.subject && <p className="mt-1 truncate text-xs"><span className="text-muted">Objet : </span>{preview ? renderTemplate(s.subject, preview.ctx).text : s.subject}</p>}
              <p className={cn("mt-1 line-clamp-2 text-xs whitespace-pre-line", excerpt ? "text-muted" : "text-danger")}>{excerpt || "Message à rédiger"}</p>
              {(vars.length > 0 || warnings.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {vars.map((v) => <span key={v} className="rounded bg-violet-soft px-1.5 py-0.5 font-label text-[10px] text-violet-strong">{`{{${v}}}`}</span>)}
                  {warnings.map((w) => (
                    <span key={w} className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800"><AlertTriangle size={10} />{w}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </button>
        <div className="flex flex-col opacity-60 group-hover:opacity-100">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="rounded p-0.5 text-muted hover:bg-surface disabled:opacity-30" aria-label="Monter"><ArrowUp size={12} /></button>
          <button onClick={() => onMove(1)} disabled={index === count - 1} className="rounded p-0.5 text-muted hover:bg-surface disabled:opacity-30" aria-label="Descendre"><ArrowDown size={12} /></button>
        </div>
      </div>
    </div>
  );
}

function StopRules() {
  return (
    <div className="mt-1 w-full rounded-xl border border-dashed border-line bg-white/80 px-3 py-2.5 text-xs">
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink"><Flag size={12} className="text-violet" /> Fin de séquence et règles d&apos;arrêt</p>
      <ul className="space-y-0.5 text-muted">
        <li><strong className="text-ink">Réponse enregistrée</strong> → relances de l&apos;entreprise suspendues (tous ses contacts, toutes campagnes).</li>
        <li><strong className="text-ink">Intéressé</strong> → vous choisissez un pipeline et une étape ; la prospection s&apos;arrête.</li>
        <li><strong className="text-ink">Pas intéressé</strong> → prospection de l&apos;entreprise arrêtée.</li>
        <li><strong className="text-ink">Ne plus contacter</strong> → arrêt et blocage de toute nouvelle activation.</li>
        <li><strong className="text-ink">Passage en pipeline</strong> → relances actives arrêtées, historique conservé.</li>
        <li><strong className="text-ink">Dernière étape réalisée</strong> → séquence terminée.</li>
      </ul>
    </div>
  );
}

function StepPanel({
  step: s, index, count, preview, previewContacts, previewId, setPreviewId, onChange, onClose, onDuplicate, onMove,
  confirmDelete, onAskDelete, onCancelDelete, onDelete, startedOnCurrent,
}: {
  step: EditorStep; index: number; count: number; preview: PreviewContact | null; previewContacts: PreviewContact[];
  previewId: string; setPreviewId: (id: string) => void; onChange: (p: Partial<EditorStep>) => void; onClose: () => void;
  onDuplicate: () => void; onMove: (d: -1 | 1) => void; confirmDelete: boolean; onAskDelete: () => void; onCancelDelete: () => void;
  onDelete: () => void; startedOnCurrent: number;
}) {
  const meta = STEP_META[s.step_type];
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<"subject" | "message">("message");
  const [varsOpen, setVarsOpen] = useState(false);
  const renderedSubject = preview ? renderTemplate(s.subject, preview.ctx) : null;
  const renderedBody = preview ? renderTemplate(s.message, preview.ctx) : null;
  const missing = [...new Set([...(renderedSubject?.missing ?? []), ...(renderedBody?.missing ?? [])])];

  function insertVariable(key: string) {
    const token = `{{${key}}}`;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const field = target === "subject" ? "subject" : "message";
    const value = (target === "subject" ? s.subject : s.message) ?? "";
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange({ [field]: value.slice(0, start) + token + value.slice(end) });
    setVarsOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <StepIcon type={s.step_type} size={13} />
        <p className="font-semibold">Étape {index + 1}</p>
        <div className="ml-auto flex">
          <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Monter"><ArrowUp size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={index === count - 1} aria-label="Descendre"><ArrowDown size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate} title="Dupliquer"><Copy size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={onAskDelete} title="Supprimer"><Trash2 size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer"><X size={13} /></Button>
        </div>
      </div>
      {confirmDelete && (
        <div className="m-3 rounded-lg border border-danger/30 bg-danger/5 p-2 text-sm">
          <p>Supprimer l&apos;étape « {s.name} » ?</p>
          {startedOnCurrent > 0 && <p className="mt-1 text-xs text-muted">Les participants déjà démarrés conservent leur version actuelle de la séquence.</p>}
          <div className="mt-2 flex justify-end gap-1">
            <Button size="sm" onClick={onCancelDelete}>Annuler</Button>
            <Button size="sm" variant="danger" onClick={onDelete}>Supprimer</Button>
          </div>
        </div>
      )}
      <div className="space-y-3 p-3">
        <div>
          <p className="mb-1 font-label text-xs font-semibold text-muted">Action</p>
          <div className="grid grid-cols-2 gap-1">
            {STEP_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => onChange({ step_type: t, name: s.name === DEFAULT_TITLE[s.step_type] ? DEFAULT_TITLE[t] : s.name })}
                className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs", s.step_type === t ? "border-violet bg-violet-soft font-semibold" : "border-line hover:bg-surface")}
              >
                <StepIcon type={t} size={11} />
                {STEP_META[t].label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <Field label="Titre *"><Input value={s.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
          <Field label={index === 0 ? "Délai (j)" : "Après (j)"}>
            <Input type="number" min={0} max={365} value={s.delay_days} onChange={(e) => onChange({ delay_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
          </Field>
        </div>
        <p className="-mt-2 text-[11px] text-muted">
          {index === 0 ? "Jours après l'activation du participant." : "Jours après la réalisation réelle de l'étape précédente."}
        </p>

        {meta.hasMessage && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="font-label text-xs font-semibold text-muted">Message pour le prospect</p>
              <div className="relative">
                <Button size="sm" variant="ghost" onClick={() => setVarsOpen((o) => !o)}><Braces size={12} /> Variable</Button>
                {varsOpen && (
                  <div className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-line bg-white p-1 shadow-xl">
                    {VARIABLES.map((v) => (
                      <button key={v.key} onClick={() => insertVariable(v.key)} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-violet-soft">
                        {v.label}<span className="font-label text-[10px] text-muted">{`{{${v.key}}}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {meta.hasSubject && (
              <Input ref={subjectRef} value={s.subject ?? ""} onFocus={() => setTarget("subject")} onChange={(e) => onChange({ subject: e.target.value })} placeholder="Objet de l'email" className="mb-1.5" />
            )}
            <Textarea
              ref={bodyRef}
              value={s.message ?? ""}
              onFocus={() => setTarget("message")}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={8}
              placeholder={s.step_type === "linkedin_invite" ? "Note d'invitation (facultative, 300 caractères max)" : "Bonjour {{prenom}}, …"}
            />
            <p className="mt-0.5 text-right font-label text-[10px] text-muted">{(s.message ?? "").length} caractères</p>
          </div>
        )}

        <Field label="Consignes internes (jamais envoyées)">
          <Textarea value={s.instructions ?? ""} onChange={(e) => onChange({ instructions: e.target.value })} rows={2} placeholder="Ex. commenter un post récent avant d'écrire" />
        </Field>

        {meta.hasMessage && (
          <div className="rounded-lg border border-line bg-surface p-2">
            <div className="mb-1 flex items-center gap-2">
              <Eye size={13} className="text-muted" />
              <p className="font-label text-xs font-semibold text-muted">Aperçu</p>
              {previewContacts.length > 0 ? (
                <Select value={previewId} onChange={(e) => setPreviewId(e.target.value)} className="ml-auto h-7 w-auto max-w-44 text-xs" aria-label="Contact pour l'aperçu">
                  {previewContacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </Select>
              ) : (
                <span className="ml-auto text-[11px] text-muted">Ajoutez des prospects pour un aperçu réel</span>
              )}
            </div>
            {preview ? (
              <>
                {meta.hasSubject && <p className="text-sm"><span className="text-muted">Objet : </span>{renderedSubject?.text || <em className="text-muted">vide</em>}</p>}
                <p className="mt-1 text-sm whitespace-pre-wrap">{renderedBody?.text || <em className="text-muted">vide</em>}</p>
                {missing.length > 0 && (
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-warning">
                    <AlertTriangle size={12} /> Donnée manquante pour ce contact : {missing.map(variableLabel).join(", ")}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted">Choisissez un contact.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
