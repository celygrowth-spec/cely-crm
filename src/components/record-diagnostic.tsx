"use client";

// Onglet Diagnostic : le CRM crée le dossier et ouvre Claude avec un court message déjà écrit.
// Claude lit le reste dans le CRM, puis y dépose questions et versions.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Download, ExternalLink, RotateCcw, Sparkles } from "lucide-react";
import { apiGet, attempt } from "@/lib/client/query";
import { DIAGNOSTIC_STATUS_LABELS, answersPrompt, claudeLink, revisionPrompt, stageOf, startPrompt, type Diagnostic, type DiagnosticQuestion, type DiagnosticStatus, type DiagnosticVersion, type TriggerStage } from "@/lib/crm/diagnostic-rules";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, Input, SaveIndicator, Skeleton, Textarea } from "./ui";

const TONES: Record<DiagnosticStatus, "neutral" | "warning" | "success" | "danger"> = {
  waiting_claude: "neutral",
  researching: "neutral",
  questions_ready: "warning",
  answers_sent: "neutral",
  generating: "neutral",
  version_ready: "success",
  revision_requested: "neutral",
  failed: "danger",
};
// Claude travaille : l'écran se met à jour seul
const WORKING: DiagnosticStatus[] = ["waiting_claude", "researching", "answers_sent", "generating", "revision_requested"];

const post = <T,>(url: string, body: Record<string, unknown>) =>
  attempt(async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: true; data: T } | { ok: false; error: string };
  });

/** Ouvre Claude et garde le message sous la main si le lien ne remplit pas la case. */
function ClaudeActions({ prompt, chatUrl, label }: { prompt: string; chatUrl: string | null; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={claudeLink(prompt, chatUrl)} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-sm font-semibold text-white hover:bg-violet-strong">
        <ExternalLink size={14} /> {label}
      </a>
      <Button onClick={async () => { await navigator.clipboard.writeText(prompt); toast.success("Message copié"); }}><Copy size={14} /> Copier le message</Button>
      <p className="w-full text-xs text-muted">Dans Claude, appuyez sur Entrée pour envoyer. Si la case reste vide, collez le message copié.</p>
    </div>
  );
}

/** Lancement automatique s'il a eu lieu ; sinon, relance et lien vers Claude en secours. */
const PROMPTS: Record<TriggerStage, { prompt: (id: string) => string; label: string; waiting: string }> = {
  start: { prompt: startPrompt, label: "Lancer dans Claude", waiting: "Ses questions arriveront ici." },
  answers: { prompt: answersPrompt, label: "Générer les slides dans Claude", waiting: "La version arrivera ici." },
  revision: { prompt: revisionPrompt, label: "Demander la version dans Claude", waiting: "La nouvelle version arrivera ici." },
};

function Launch({ dossier, stage, reload }: { dossier: Diagnostic; stage: TriggerStage; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const auto = dossier.status !== "failed" && dossier.trigger_stage === stage && dossier.triggered_at && !dossier.trigger_error;
  async function retry() {
    setBusy(true);
    const r = await post<{ triggered: boolean }>(`/api/diagnostics/${dossier.id}`, { op: "trigger", stage });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Claude est relancé");
    reload();
  }
  if (auto) {
    return (
      <p className="text-sm">
        Claude a été lancé automatiquement le {formatDateTime(dossier.triggered_at!)}. {PROMPTS[stage].waiting}
        {dossier.chat_url && <> <a className="font-semibold text-violet-strong underline" href={dossier.chat_url} target="_blank" rel="noreferrer noopener">Suivre la session</a></>}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      {(dossier.trigger_error || dossier.status === "failed") && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {dossier.trigger_error && <span className="text-danger">Lancement automatique impossible : {dossier.trigger_error}</span>}
          <Button size="sm" disabled={busy} onClick={retry}><RotateCcw size={13} /> Relancer Claude</Button>
        </div>
      )}
      <ClaudeActions prompt={PROMPTS[stage].prompt(dossier.id)} chatUrl={dossier.chat_url} label={PROMPTS[stage].label} />
    </div>
  );
}

function ChatLink({ dossier, reload }: { dossier: Diagnostic; reload: () => void }) {
  const [url, setUrl] = useState(dossier.chat_url ?? "");
  async function save() {
    if (url.trim() === (dossier.chat_url ?? "")) return;
    const r = await post<null>(`/api/diagnostics/${dossier.id}`, { op: "chat", url });
    if (!r.ok) return toast.error(r.error);
    toast.success("Chat associé au dossier");
    reload();
  }
  return (
    <label className="block text-sm">
      <span className="font-label text-xs font-semibold text-muted">Adresse de la session ou du chat Claude, pour y revenir</span>
      <Input className="mt-1" placeholder="https://claude.ai/chat/…" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={save} />
    </label>
  );
}

function Question({ dossierId, q, locked, onSaved }: { dossierId: string; q: DiagnosticQuestion; locked: boolean; onSaved: () => void }) {
  const [answer, setAnswer] = useState(q.answer ?? "");
  const [dontKnow, setDontKnow] = useState(q.dont_know);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const seq = useRef(0);

  async function save(nextAnswer: string, nextDontKnow: boolean) {
    const token = ++seq.current;
    setState("saving");
    const r = await post<null>(`/api/diagnostics/${dossierId}`, { op: "answer", question_id: q.id, answer: nextAnswer, dont_know: nextDontKnow });
    if (token !== seq.current) return; // une sauvegarde plus récente est partie
    if (!r.ok) {
      setState("error");
      toast.error(r.error);
      return;
    }
    setState("saved");
    onSaved();
  }

  return (
    <li className="rounded-xl border border-line p-3">
      <p className="text-sm font-semibold"><span className="text-muted">{q.position}.</span> {q.question}</p>
      {q.why && <p className="mt-0.5 text-xs text-muted">{q.why}</p>}
      {locked ? (
        <p className="mt-2 text-sm whitespace-pre-wrap">{q.dont_know ? <span className="text-muted">Je ne sais pas</span> : q.answer}</p>
      ) : (
        <>
          <Textarea
            className="mt-2"
            rows={2}
            value={answer}
            disabled={dontKnow}
            aria-label={`Réponse à la question ${q.position}`}
            onChange={(e) => setAnswer(e.target.value)}
            onBlur={() => { if (answer !== (q.answer ?? "")) save(answer, dontKnow); }}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={dontKnow} onChange={(e) => { setDontKnow(e.target.checked); save(answer, e.target.checked); }} /> Je ne sais pas
            </label>
            {state !== "idle" && <SaveIndicator state={state} />}
          </div>
        </>
      )}
    </li>
  );
}

/** Retour sur la dernière version reçue : la suivante est produite à partir de ce fichier et de ce texte. */
function Revision({ dossierId, version, reload }: { dossierId: string; version: DiagnosticVersion; reload: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  async function send() {
    setSending(true);
    const r = await post<{ status: string; triggered: boolean; error?: string }>(`/api/diagnostics/${dossierId}`, { op: "revise", version: version.version, feedback });
    setSending(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.error) toast.error(`Demande enregistrée, mais Claude n'a pas été lancé : ${r.data.error}`);
    else if (r.data.triggered) toast.success(`Claude prépare la V${version.version + 1}`);
    reload();
  }
  return (
    <div className="mt-2 grid gap-2 border-t border-line pt-2">
      <Textarea
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        aria-label={`Retour sur la V${version.version}`}
        placeholder="Ex. : sur la slide concurrents, distingue les concurrents commerciaux des concurrents SEO. Développe les mots-clés pour la cible PME."
      />
      <Button className="justify-self-start" variant="primary" disabled={sending || !feedback.trim()} onClick={send}>{sending ? "Envoi…" : "Demander une nouvelle version"}</Button>
    </div>
  );
}

function Dossier({ dossier, reload }: { dossier: Diagnostic; reload: () => void }) {
  const [sending, setSending] = useState(false);
  const locked = dossier.status !== "questions_ready";
  const missing = dossier.questions.filter((q) => !q.answer && !q.dont_know).length;
  const latestReady = dossier.versions.find((v) => v.status === "ready");

  async function submit() {
    setSending(true);
    const r = await post<{ status: string; triggered: boolean; error?: string }>(`/api/diagnostics/${dossier.id}`, { op: "submit" });
    setSending(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.error) toast.error(`Réponses envoyées, mais Claude n'a pas été lancé : ${r.data.error}`);
    else if (r.data.triggered) toast.success("Réponses envoyées : Claude génère les slides");
    reload();
  }

  async function download(fileId: string) {
    const r = await post<string>("/api/files", { op: "url", id: fileId, download: true });
    if (!r.ok) return toast.error(r.error);
    window.location.assign(r.data);
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-2 rounded-xl border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TONES[dossier.status]}>{DIAGNOSTIC_STATUS_LABELS[dossier.status]}</Badge>
          <span className="text-xs text-muted">Dossier créé le {formatDateTime(dossier.created_at)}</span>
        </div>
        {dossier.status === "failed" && dossier.last_error && <p className="text-sm text-danger">{dossier.last_error}</p>}
        {dossier.status === "waiting_claude" && <Launch dossier={dossier} stage="start" reload={reload} />}
        {dossier.status === "answers_sent" && <Launch dossier={dossier} stage="answers" reload={reload} />}
        {dossier.status === "revision_requested" && <Launch dossier={dossier} stage="revision" reload={reload} />}
        {dossier.status === "failed" && <Launch dossier={dossier} stage={stageOf(dossier)} reload={reload} />}
        <ChatLink key={dossier.chat_url ?? ""} dossier={dossier} reload={reload} />
      </section>

      {dossier.summary && (
        <section>
          <h3 className="font-display text-base font-bold">Synthèse</h3>
          <p className="mt-1 text-sm whitespace-pre-wrap">{dossier.summary}</p>
          {dossier.sources.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {dossier.sources.map((s, i) => (
                <li key={i}>
                  {s.url && /^https?:\/\//.test(s.url) ? <a className="underline" href={s.url} target="_blank" rel="noreferrer noopener">{s.titre}</a> : s.titre}
                  {" · "}{s.nature === "fait" ? "Fait vérifié" : s.nature === "hypothese" ? "Hypothèse" : "Fourni par le prospect"}
                  {s.date && ` · ${s.date}`}{s.marche && ` · ${s.marche}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {dossier.questions.length > 0 && (
        <section>
          <h3 className="font-display text-base font-bold">Questions</h3>
          <ol className="mt-2 grid gap-2">
            {dossier.questions.map((q) => <Question key={q.id} dossierId={dossier.id} q={q} locked={locked} onSaved={reload} />)}
          </ol>
          {!locked && (
            <div className="mt-3">
              <Button variant="primary" disabled={sending || missing > 0} onClick={submit}>{sending ? "Envoi…" : "Envoyer et générer les slides"}</Button>
              {missing > 0 && <p className="mt-1 text-xs text-muted">Encore {missing} question{missing > 1 ? "s" : ""} sans réponse.</p>}
            </div>
          )}
        </section>
      )}

      {dossier.versions.length > 0 && (
        <section>
          <h3 className="font-display text-base font-bold">Versions</h3>
          <ul className="mt-2 space-y-1">
            {dossier.versions.map((v) => (
              <li key={v.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">V{v.version}</span>
                  <Badge tone={v.status === "ready" ? "success" : "neutral"}>{v.status === "ready" ? "Fichier reçu" : "Dépôt en cours"}</Badge>
                  <span className="text-xs text-muted">{formatDateTime(v.ready_at ?? v.created_at)}</span>
                  {v.status === "ready" && (v.file_id
                    ? <Button size="sm" className="ml-auto" onClick={() => download(v.file_id!)}><Download size={13} /> Télécharger</Button>
                    : <span className="ml-auto text-xs text-muted">Fichier supprimé de la fiche</span>)}
                </div>
                {v.feedback && <p className="mt-1.5 text-xs whitespace-pre-wrap text-muted"><span className="font-semibold">Retour du {formatDateTime(v.feedback_at!)} :</span> {v.feedback}</p>}
                {dossier.status === "version_ready" && v.id === latestReady?.id && <Revision dossierId={dossier.id} version={v} reload={reload} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function RecordDiagnostic({ companyId, startSignal }: { companyId: string; startSignal: number }) {
  const qc = useQueryClient();
  const key = ["company-diagnostics", companyId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Diagnostic[]>(`/api/fiches/${companyId}/diagnostics`, signal),
    refetchInterval: (q) => (q.state.data?.some((d) => WORKING.includes(d.status)) ? 15_000 : false),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // une même demande garde sa clé : un double clic ou une nouvelle tentative ne crée pas un second dossier
  const requestKey = useRef<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  async function create() {
    if (creating) return;
    setCreating(true);
    requestKey.current ??= crypto.randomUUID();
    const r = await post<{ id: string; triggered: boolean; error?: string }>(`/api/fiches/${companyId}/diagnostics`, { request_key: requestKey.current });
    setCreating(false);
    if (!r.ok) return toast.error(r.error);
    requestKey.current = null;
    if (r.data.error) toast.error(`Dossier créé, mais Claude n'a pas été lancé : ${r.data.error}`);
    else if (r.data.triggered) toast.success("Dossier créé : Claude a démarré");
    setSelected(r.data.id);
    await qc.invalidateQueries({ queryKey: key });
  }

  async function askNew() {
    if (data?.length && !confirm("Créer un nouveau dossier de diagnostic ? Les dossiers existants restent conservés.")) return;
    await create();
  }

  // le bouton de l'en-tête demande un lancement
  const seen = useRef(0);
  const ready = !!data;
  const empty = data?.length === 0;
  useEffect(() => {
    if (!startSignal || startSignal === seen.current || !ready) return;
    seen.current = startSignal;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- action demandée depuis l'en-tête de la fiche
    if (empty) create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal, ready, empty]);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) return <p className="text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>;
  if (!data?.length) {
    return (
      <div className="rounded-xl border border-dashed border-line p-5 text-center">
        <p className="font-semibold">Aucun diagnostic pour cette fiche</p>
        <p className="mt-1 text-sm text-muted">Le CRM crée un dossier et lance Claude, qui lit la fiche et la bibliothèque, fait ses recherches, puis vous pose ses questions ici.</p>
        <Button className="mt-3" variant="primary" disabled={creating} onClick={create}><Sparkles size={14} /> Générer un diagnostic</Button>
      </div>
    );
  }
  const current = data.find((d) => d.id === selected) ?? data[0];
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {data.length > 1 && (
          <select className="h-9 rounded-lg border border-line bg-white px-2 text-sm" value={current.id} onChange={(e) => setSelected(e.target.value)} aria-label="Dossier affiché">
            {data.map((d) => <option key={d.id} value={d.id}>Dossier du {formatDateTime(d.created_at)}</option>)}
          </select>
        )}
        <Button className="ml-auto" disabled={creating} onClick={askNew}><Sparkles size={14} /> Nouveau diagnostic</Button>
      </div>
      <Dossier key={current.id} dossier={current} reload={reload} />
    </div>
  );
}
