"use client";

// Écran commun des générateurs (proposition, onboarding), sur le modèle du diagnostic : sources rassemblées,
// questions pré-remplies avec leur provenance, génération d'une version, relecture, validation.
// Ce qui est propre à un générateur (devis, envoi, signature) arrive par les emplacements `recapMake` et `versionExtra`.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Download, ExternalLink, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { QUESTIONS } from "@/content/generators";
import { apiGet } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import {
  GENERATOR_NAMES, SOURCE_TYPE_LABELS, STATE_LABELS, STATE_TONES, answerText, dossierState, generatorPrompt, isBlank, latestVersion, linesTotal, missingRequired,
  provenanceLabel, sections, versionState,
  type Answer, type AnswerValue, type Answers, type GeneratorDossier, type GeneratorKind, type GeneratorVersion, type PersonValue, type Question, type QuoteLine,
} from "@/lib/generators/rules";
import { Badge, Button, Input, SaveIndicator, Skeleton, Textarea } from "../ui";
import { ClaudeActions, downloadFile, openFile, post } from "./shared";

export type PersonOption = { id: string; first_name: string | null; last_name: string | null; title: string | null; email: string | null };
export type PanelSlots = {
  /** Ce qui part à Make, montré dans le récapitulatif avant de générer. */
  recapMake?: (answers: Answers) => React.ReactNode;
  /** Bloc propre au générateur sous une version (devis, envoi, signature). */
  versionExtra?: (dossier: GeneratorDossier, version: GeneratorVersion, reload: () => void) => React.ReactNode;
  /** Suite proposée à la fin du livrable (bouton de l'étape suivante). */
  after?: (dossier: GeneratorDossier) => React.ReactNode;
};

const eur = (n: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
export const generatorKey = (kind: GeneratorKind, companyId: string) => ["generator", kind, companyId];
const working = (d: GeneratorDossier) => d.prefill_state === "requested" || dossierState(d) === "en_generation";

export function GeneratorPanel({ companyId, kind, projectId = null, people, slots = {} }: {
  companyId: string; kind: GeneratorKind; projectId?: string | null; people: PersonOption[]; slots?: PanelSlots;
}) {
  const qc = useQueryClient();
  const key = generatorKey(kind, companyId);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<GeneratorDossier[]>(`/api/fiches/${companyId}/generateurs?kind=${kind}`, signal),
    refetchInterval: (q) => (q.state.data?.some(working) ? 15_000 : false),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // une même demande garde sa clé : un double clic ou une nouvelle tentative ne crée pas un second dossier
  const requestKey = useRef<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const name = GENERATOR_NAMES[kind];

  async function create() {
    if (creating) return;
    setCreating(true);
    requestKey.current ??= crypto.randomUUID();
    const r = await post<{ id: string; triggered: boolean; error?: string }>(`/api/fiches/${companyId}/generateurs`, { kind, project_id: projectId, request_key: requestKey.current });
    setCreating(false);
    if (!r.ok) return toast.error(r.error);
    requestKey.current = null;
    if (r.data.error) toast.error(`Dossier créé, mais Claude n'a pas été lancé : ${r.data.error}`);
    setSelected(r.data.id);
    await reload();
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) return <p className="text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>;
  if (!data?.length) {
    return (
      <div className="rounded-xl border border-dashed border-line p-5 text-center" data-generator-empty={kind}>
        <p className="font-semibold">Aucun dossier pour {name.the}</p>
        <p className="mt-1 text-sm text-muted">Le CRM rassemble ce qu&apos;il sait déjà, pré-remplit les questions, puis vous complétez avant de générer.</p>
        <Button className="mt-3" variant="primary" disabled={creating} onClick={create}><Sparkles size={14} /> Générer {name.the}</Button>
      </div>
    );
  }
  const current = data.find((d) => d.id === selected) ?? data[0];
  return (
    <div className="grid gap-3" data-generator={kind}>
      <div className="flex flex-wrap items-center gap-2">
        {data.length > 1 && (
          <select className="h-9 rounded-lg border border-line bg-white px-2 text-sm" value={current.id} onChange={(e) => setSelected(e.target.value)} aria-label="Dossier affiché">
            {data.map((d) => <option key={d.id} value={d.id}>Dossier du {formatDateTime(d.created_at)}</option>)}
          </select>
        )}
        <Button className="ml-auto" size="sm" disabled={creating} onClick={() => { if (confirm("Créer un nouveau dossier ? Les dossiers existants restent conservés.")) void create(); }}><Sparkles size={13} /> Nouveau dossier</Button>
      </div>
      <Dossier key={current.id} d={current} kind={kind} people={people} slots={slots} reload={reload} />
    </div>
  );
}

function Dossier({ d, kind, people, slots, reload }: { d: GeneratorDossier; kind: GeneratorKind; people: PersonOption[]; slots: PanelSlots; reload: () => void }) {
  const autoRoutine = d.auto_routine;
  const questions = QUESTIONS[kind];
  const state = dossierState(d);
  const latest = latestVersion(d);
  const generating = !!latest && versionState(latest) === "en_generation";
  const missing = missingRequired(questions, d.answers);
  const [recap, setRecap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  // la clé d'une génération ne change qu'une fois celle-ci acceptée : double clic et reprise réseau rendent la même version
  const genKey = useRef<string | null>(null);
  const url = `/api/generateurs/${d.id}`;

  async function generate() {
    if (busy) return;
    setBusy(true);
    genKey.current ??= crypto.randomUUID();
    const r = await post<{ version: number; created: boolean; slides: { triggered: boolean; error?: string } }>(url, { op: "generate", request_key: genKey.current, feedback });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    genKey.current = null;
    setRecap(false);
    setFeedback("");
    if (r.data.slides.error) toast.error(`Version V${r.data.version} créée, mais Claude n'a pas été lancé : ${r.data.slides.error}`);
    else toast.success(r.data.created ? `Version V${r.data.version} en génération` : `La version V${r.data.version} est déjà en cours`);
    reload();
  }
  async function act(body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    const r = await post<{ triggered?: boolean; error?: string }>(url, body);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data?.error) toast.error(r.data.error);
    else toast.success(done);
    reload();
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-2 rounded-xl border border-line p-3" data-generator-state={state}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}{latest ? ` · V${latest.version}` : ""}</Badge>
          <span className="text-xs text-muted">Dossier créé le {formatDateTime(d.created_at)}</span>
        </div>
        {d.prefill_state === "requested" && <p className="text-sm">Claude lit les échanges et propose des réponses. Vous pouvez déjà compléter : vos réponses ne seront jamais remplacées.{d.session_url && <> <a className="font-semibold text-violet-strong underline" href={d.session_url} target="_blank" rel="noreferrer noopener">Suivre la session</a></>}</p>}
        {(d.last_error || d.trigger_error) && (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-generator-error>
            <span className="text-danger">{d.last_error ?? `Lancement automatique impossible : ${d.trigger_error}`}</span>
            <span className="text-muted">Vos réponses sont conservées.</span>
            {latest && latest.slides_status === "failed"
              ? <Button size="sm" disabled={busy} onClick={() => act({ op: "retry", version_id: latest.id }, "Génération relancée")}><RotateCcw size={13} /> Réessayer</Button>
              : !latest && autoRoutine && <Button size="sm" disabled={busy} onClick={() => act({ op: "trigger" }, "Claude est relancé")}><RotateCcw size={13} /> Réessayer</Button>}
          </div>
        )}
        {!autoRoutine && !latest && d.prefill_state !== "done" && (
          <ClaudeActions prompt={generatorPrompt(kind, "preremplissage", d.id)} chatUrl={null} label="Pré-remplir dans Claude" />
        )}
        {!autoRoutine && generating && <ClaudeActions prompt={generatorPrompt(kind, "slides", d.id)} chatUrl={null} label="Générer dans Claude" />}
      </section>

      <Selection d={d} reload={reload} />

      <section>
        <h3 className="font-display text-base font-bold">Questions</h3>
        {sections(questions).map((s) => (
          <div key={s} className="mt-3">
            <h4 className="font-label text-xs font-bold tracking-wide text-muted uppercase">{s}</h4>
            <ol className="mt-1.5 grid gap-2">
              {questions.filter((q) => q.section === s).map((q) => <QuestionRow key={q.key} url={url} q={q} answer={d.answers[q.key]} people={people} onSaved={reload} />)}
            </ol>
          </div>
        ))}
        <div className="mt-4 grid gap-2">
          {latest && (
            <Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-label="Retour pour la prochaine version"
              placeholder={`Facultatif : ce qu'il faut changer par rapport à la V${latest.version}.`} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy || generating || missing.length > 0} onClick={() => setRecap(true)} data-generate>
              <Sparkles size={14} /> {latest ? "Régénérer" : "Générer"}
            </Button>
            {missing.length > 0 && <p className="text-xs text-muted">Encore {missing.length} question{missing.length > 1 ? "s" : ""} obligatoire{missing.length > 1 ? "s" : ""} sans réponse.</p>}
            {generating && <p className="text-xs text-muted">La V{latest!.version} est en cours de génération.</p>}
            {latest && !generating && <p className="text-xs text-muted">Régénérer repart de ces réponses et crée la V{latest.version + 1}. Les versions précédentes restent consultables.</p>}
          </div>
        </div>
      </section>

      {d.versions.length > 0 && (
        <section>
          <h3 className="font-display text-base font-bold">Versions</h3>
          <ul className="mt-2 space-y-2">
            {d.versions.map((v) => <VersionRow key={v.id} d={d} v={v} busy={busy} slots={slots} reload={reload}
              onValidate={() => act({ op: "validate", version_id: v.id }, `V${v.version} validée`)}
              onRetry={() => act({ op: "retry", version_id: v.id }, "Génération relancée")} />)}
          </ul>
        </section>
      )}
      {slots.after?.(d)}

      {recap && <Recap d={d} kind={kind} busy={busy} slots={slots} onClose={() => setRecap(false)} onConfirm={generate} />}
    </div>
  );
}

function VersionRow({ d, v, busy, slots, reload, onValidate, onRetry }: { d: GeneratorDossier; v: GeneratorVersion; busy: boolean; slots: PanelSlots; reload: () => void; onValidate: () => void; onRetry: () => void }) {
  const state = versionState(v);
  return (
    <li className="rounded-lg border border-line px-3 py-2 text-sm" data-version={v.version} data-version-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">V{v.version}</span>
        <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
        <span className="text-xs text-muted">{formatDateTime(v.ready_at ?? v.created_at)}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {v.slides_status === "ready" && (v.file_id ? (
            <>
              <Button size="sm" onClick={() => openFile(v.file_id!)}><ExternalLink size={13} /> Ouvrir les slides</Button>
              <Button size="sm" variant="ghost" onClick={() => downloadFile(v.file_id!)} aria-label={`Télécharger la V${v.version}`}><Download size={13} /></Button>
            </>
          ) : <span className="text-xs text-muted">Fichier supprimé de la fiche</span>)}
          {state === "a_relire" && <Button size="sm" variant="primary" disabled={busy} onClick={onValidate}><Check size={13} /> Valider</Button>}
          {state === "echec" && <Button size="sm" disabled={busy} onClick={onRetry}><RotateCcw size={13} /> Réessayer</Button>}
        </span>
      </div>
      {v.slides_status === "failed" && v.slides_error && <p className="mt-1 text-xs text-danger">{v.slides_error}</p>}
      {v.feedback && <p className="mt-1.5 text-xs whitespace-pre-wrap text-muted"><span className="font-semibold">Retour demandé :</span> {v.feedback}</p>}
      {v.validated_at && <p className="mt-1 text-xs text-muted">Validée le {formatDateTime(v.validated_at)} : elle ne se modifie plus.{v.sent_at && ` Envoyée le ${formatDateTime(v.sent_at)}.`}</p>}
      {slots.versionExtra?.(d, v, reload)}
    </li>
  );
}

/** Sources retenues et sélection de la bibliothèque : réglables jusqu'à la génération, sans quitter l'écran. */
function Selection({ d, reload }: { d: GeneratorDossier; reload: () => void }) {
  const [saving, setSaving] = useState(false);
  const kept = d.sources.filter((s) => s.retenue).length;
  const chosen = d.library.filter((l) => l.selected);
  async function save(excluded: string[], library: string[] | null) {
    setSaving(true);
    const r = await post<null>(`/api/generateurs/${d.id}`, { op: "selection", excluded, library });
    setSaving(false);
    if (!r.ok) return toast.error(r.error);
    reload();
  }
  const excluded = d.sources.filter((s) => !s.retenue).map((s) => s.cle);
  const toggleSource = (cle: string, on: boolean) => save(on ? excluded.filter((x) => x !== cle) : [...excluded, cle], null);
  const toggleLibrary = (id: string, on: boolean) => save(excluded, on ? [...chosen.map((l) => l.id), id] : chosen.filter((l) => l.id !== id).map((l) => l.id));
  return (
    <section className="grid gap-2 md:grid-cols-2">
      <details className="rounded-xl border border-line p-3" data-sources>
        <summary className="cursor-pointer text-sm font-semibold">Sources retenues · {kept} sur {d.sources.length}</summary>
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm">
          {d.sources.map((s) => (
            <li key={s.cle}>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={s.retenue} disabled={saving || s.cle === "fiche"} onChange={(e) => toggleSource(s.cle, e.target.checked)} />
                <span><span className="text-muted">{SOURCE_TYPE_LABELS[s.type] ?? s.type} · </span>{s.titre}{s.date && <span className="text-xs text-muted"> · {formatDateTime(s.date)}</span>}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Une source décochée n&apos;est pas lisible par l&apos;IA pour ce dossier.</p>
      </details>
      <details className="rounded-xl border border-line p-3" data-library>
        <summary className="cursor-pointer text-sm font-semibold">Bibliothèque · {chosen.length} élément{chosen.length > 1 ? "s" : ""}</summary>
        {d.library.length === 0 ? <p className="mt-2 text-sm text-muted">La bibliothèque est vide.</p> : (
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm">
            {d.library.map((l) => (
              <li key={l.id}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={l.selected} disabled={saving} onChange={(e) => toggleLibrary(l.id, e.target.checked)} />
                  <span>{l.name}<span className="text-xs text-muted"> · {l.kind === "prompt" ? "Prompt" : "Fichier"} · {l.folder}</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Sélection par défaut réglable dans Paramètres › Générateurs ; ajustée ici pour ce dossier seulement.</p>
      </details>
    </section>
  );
}

function QuestionRow({ url, q, answer, people, onSaved }: { url: string; q: Question; answer: Answer | undefined; people: PersonOption[]; onSaved: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const seq = useRef(0);
  async function save(value: AnswerValue | "") {
    const token = ++seq.current;
    setState("saving");
    const r = await post<null>(url, { op: "answer", key: q.key, value });
    if (token !== seq.current) return; // une sauvegarde plus récente est partie
    if (!r.ok) {
      setState("error");
      return void toast.error(r.error);
    }
    setState("saved");
    onSaved();
  }
  const from = provenanceLabel(answer);
  return (
    <li className="rounded-xl border border-line p-3" data-question={q.key}>
      <p className="text-sm font-semibold">{q.label}{q.required && <span className="text-danger" title="Obligatoire"> *</span>}{q.make && <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">part à Make</span>}</p>
      {q.help && <p className="mt-0.5 text-xs text-muted">{q.help}</p>}
      {/* la clé change quand la réponse arrive d'ailleurs (CRM, Claude) : le champ reprend alors la valeur enregistrée */}
      <div className="mt-2"><Field key={`${answer?.origin ?? ""}:${JSON.stringify(answer?.value ?? null)}`} q={q} value={answer?.value} people={people} save={save} /></div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-xs text-muted" data-provenance>{from ? `↳ ${from}` : isBlank(answer?.value) ? "À compléter" : ""}</p>
        {state !== "idle" && <SaveIndicator state={state} />}
      </div>
    </li>
  );
}

function Field({ q, value, people, save }: { q: Question; value: AnswerValue | undefined; people: PersonOption[]; save: (v: AnswerValue | "") => void }) {
  const [text, setText] = useState(typeof value === "string" || typeof value === "number" ? String(value) : "");
  const label = `Réponse : ${q.label}`;
  const blur = () => { if (text !== (value === undefined ? "" : String(value))) save(q.type === "number" ? (text.trim() === "" ? "" : Number(text.replace(",", "."))) : text); };
  if (q.type === "long") return <Textarea rows={3} value={text} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={blur} />;
  if (q.type === "text") return <Input value={text} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={blur} />;
  if (q.type === "number") return <Input className="max-w-40" inputMode="decimal" value={text} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={blur} />;
  if (q.type === "date") return <Input className="max-w-48" type="date" value={text} aria-label={label} onChange={(e) => { setText(e.target.value); save(e.target.value); }} />;
  if (q.type === "choice") {
    return (
      <select className="h-9 w-full max-w-md rounded-lg border border-line bg-white px-2 text-sm" value={text} aria-label={label} onChange={(e) => { setText(e.target.value); save(e.target.value); }}>
        <option value="">Choisir…</option>
        {q.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (q.type === "person") return <PersonField value={value as PersonValue | undefined} people={people} label={label} save={save} />;
  return <LinesField value={(value as QuoteLine[] | undefined) ?? []} save={save} />;
}

function PersonField({ value, people, label, save }: { value: PersonValue | undefined; people: PersonOption[]; label: string; save: (v: AnswerValue | "") => void }) {
  const known = value?.person_id && people.some((p) => p.id === value.person_id) ? value.person_id : value ? "other" : "";
  const [mode, setMode] = useState(known);
  const [p, setP] = useState<PersonValue>(value ?? { first_name: "", last_name: "", title: "", email: "" });
  const commit = (next: PersonValue) => { if (`${next.first_name}${next.last_name}`.trim()) save(next); };
  return (
    <div className="grid gap-2">
      <select className="h-9 w-full max-w-md rounded-lg border border-line bg-white px-2 text-sm" value={mode} aria-label={label}
        onChange={(e) => {
          setMode(e.target.value);
          const found = people.find((x) => x.id === e.target.value);
          if (found) save({ person_id: found.id, first_name: found.first_name ?? "", last_name: found.last_name ?? "", title: found.title, email: found.email });
          else if (!e.target.value) save("");
        }}>
        <option value="">Choisir…</option>
        {people.map((x) => <option key={x.id} value={x.id}>{[`${x.first_name ?? ""} ${x.last_name ?? ""}`.trim(), x.title, x.email].filter(Boolean).join(" · ")}</option>)}
        <option value="other">Autre personne…</option>
      </select>
      {mode === "other" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {(["first_name", "last_name", "title", "email"] as const).map((f) => (
            <Input key={f} value={p[f] ?? ""} placeholder={{ first_name: "Prénom", last_name: "Nom", title: "Fonction", email: "Email" }[f]} aria-label={{ first_name: "Prénom", last_name: "Nom", title: "Fonction", email: "Email" }[f]}
              onChange={(e) => setP({ ...p, [f]: e.target.value })} onBlur={() => commit({ ...p, person_id: null })} />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_LINE: QuoteLine = { label: "", quantity: 1, unit: "mois", unit_price: 0, vat_rate: 20, recurrence: "monthly" };

function LinesField({ value, save }: { value: QuoteLine[]; save: (v: AnswerValue | "") => void }) {
  const [lines, setLines] = useState<QuoteLine[]>(value);
  const commit = (next: QuoteLine[]) => { setLines(next); if (next.every((l) => l.label.trim())) save(next); };
  const edit = (i: number, patch: Partial<QuoteLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (s: string) => Number(s.replace(",", ".")) || 0;
  return (
    <div className="grid gap-2" data-lines>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 rounded-lg bg-surface p-2 md:grid-cols-[2fr_70px_90px_110px_70px_120px_32px]">
          <Input className="col-span-2 md:col-span-1" value={l.label} placeholder="Libellé" aria-label={`Libellé de la ligne ${i + 1}`} onChange={(e) => edit(i, { label: e.target.value })} onBlur={() => commit(lines)} />
          <Input inputMode="decimal" defaultValue={l.quantity} aria-label={`Quantité de la ligne ${i + 1}`} onBlur={(e) => commit(lines.map((x, j) => (j === i ? { ...x, quantity: num(e.target.value) } : x)))} />
          <Input value={l.unit} placeholder="Unité" aria-label={`Unité de la ligne ${i + 1}`} onChange={(e) => edit(i, { unit: e.target.value })} onBlur={() => commit(lines)} />
          <Input inputMode="decimal" defaultValue={l.unit_price} aria-label={`Prix unitaire HT de la ligne ${i + 1}`} onBlur={(e) => commit(lines.map((x, j) => (j === i ? { ...x, unit_price: num(e.target.value) } : x)))} />
          <Input inputMode="decimal" defaultValue={l.vat_rate} aria-label={`TVA de la ligne ${i + 1}`} onBlur={(e) => commit(lines.map((x, j) => (j === i ? { ...x, vat_rate: num(e.target.value) } : x)))} />
          <select className="h-9 rounded-lg border border-line bg-white px-2 text-sm" value={l.recurrence} aria-label={`Récurrence de la ligne ${i + 1}`} onChange={(e) => commit(lines.map((x, j) => (j === i ? { ...x, recurrence: e.target.value as QuoteLine["recurrence"] } : x)))}>
            <option value="monthly">Par mois</option>
            <option value="one_off">Ponctuel</option>
          </select>
          <Button size="sm" variant="ghost" aria-label={`Retirer la ligne ${i + 1}`} onClick={() => { const next = lines.filter((_, j) => j !== i); setLines(next); save(next.length ? next : ""); }}><Trash2 size={13} /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => setLines([...lines, EMPTY_LINE])}><Plus size={13} /> Ajouter une ligne</Button>
        {lines.length > 0 && <p className="text-xs text-muted">Quantité · unité · prix unitaire HT · TVA %. Total HT : <span className="font-semibold text-ink">{eur(linesTotal(lines))}</span></p>}
      </div>
    </div>
  );
}

/** Avant de générer : ce qui part à l'IA, ce qui part à Make. Rien ne part sans ce clic. */
function Recap({ d, kind, busy, slots, onClose, onConfirm }: { d: GeneratorDossier; kind: GeneratorKind; busy: boolean; slots: PanelSlots; onClose: () => void; onConfirm: () => void }) {
  const questions = QUESTIONS[kind];
  const kept = d.sources.filter((s) => s.retenue);
  const byType = Object.entries(kept.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.type]: (acc[s.type] ?? 0) + 1 }), {}));
  const lib = d.library.filter((l) => l.selected);
  const forAi = questions.filter((q) => !q.internal && !isBlank(d.answers[q.key]?.value));
  const make = slots.recapMake?.(d.answers);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-ink/30" aria-label="Fermer le récapitulatif" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Récapitulatif avant génération" className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" data-recap>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold">Avant de générer {GENERATOR_NAMES[kind].the}</h3>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface"><X size={18} /></button>
        </div>
        <h4 className="mt-4 font-label text-xs font-bold tracking-wide text-muted uppercase">Ce qui part à l&apos;IA</h4>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm" data-recap-ai>
          <li>{kept.length} source{kept.length > 1 ? "s" : ""} : {byType.map(([t, n]) => `${n} × ${(SOURCE_TYPE_LABELS[t] ?? t).toLowerCase()}`).join(", ")}</li>
          <li>Bibliothèque : {lib.length ? lib.map((l) => l.name).join(", ") : "aucun élément"}</li>
          <li>{forAi.length} réponse{forAi.length > 1 ? "s" : ""} du questionnaire{questions.some((q) => q.internal) ? " (les coordonnées de facturation restent dans le CRM)" : ""}</li>
        </ul>
        <dl className="mt-2 max-h-52 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
          {forAi.map((q) => (
            <div key={q.key} className="grid gap-0.5 px-3 py-1.5 sm:grid-cols-[40%_1fr]">
              <dt className="text-muted">{q.label}</dt>
              <dd className="whitespace-pre-wrap">{answerText(q, d.answers[q.key]?.value)}</dd>
            </div>
          ))}
        </dl>
        {make && (
          <>
            <h4 className="mt-4 font-label text-xs font-bold tracking-wide text-muted uppercase">Ce qui part à Make</h4>
            <div className="mt-1 text-sm" data-recap-make>{make}</div>
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Revenir aux questions</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm} data-confirm-generate><Sparkles size={14} /> {busy ? "Lancement…" : "Générer"}</Button>
        </div>
      </div>
    </div>
  );
}
