"use client";

// Projet créé depuis « Gagné » : ce qui est prêt, ce qui bloque le démarrage, et le prochain bouton.
// Tout ici est interne : seule une demande partagée explicitement ou une version de slides partagée
// devient visible du client.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronDown, Copy, Download, ExternalLink, FileText, Pencil, RefreshCw, Send, Sparkles, Upload } from "lucide-react";
import { Badge, Button, Card, Field, Input, Modal, Select, Skeleton, Spinner, Textarea, cn } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  ONBOARDING_STATUS_LABELS, ONBOARDING_STATUS_TONES, ORIGIN_LABELS, SECTION_TITLES, analysisPrompt, claudeLink, slidesPrompt,
  type Onboarding, type OnboardingDeck, type OnboardingItem, type SectionItem, type SectionKey, type SourceRef,
} from "@/lib/projects/onboarding-rules";

type Op = Record<string, unknown> & { op: string };
const post = <T,>(projectId: string, body: Op) =>
  attempt(async () => {
    const res = await fetch(`/api/projets/${projectId}/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: true; data: T } | { ok: false; error: string };
  });

const MAIN: SectionKey[] = ["mission", "objectives", "scope", "deliverables", "phases", "first_actions"];
const CONTEXT: SectionKey[] = ["context", "findings"];

export function OnboardingPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const key = ["onboarding", projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Onboarding | null>(`/api/projets/${projectId}/onboarding`, signal),
    refetchInterval: (query) => (query.state.data?.status === "preparing" || query.state.data?.decks.some((d) => d.status === "requested" || d.status === "uploading") ? 5000 : false),
  });
  const started = useRef(false);
  const o = q.data;

  // Préparation jamais lancée (onglet fermé trop tôt, erreur réseau) : elle démarre à l'ouverture du projet.
  useEffect(() => {
    if (o?.prep_state === "pending" && !started.current) {
      started.current = true;
      void post(projectId, { op: "prepare" }).then(() => qc.invalidateQueries({ queryKey: key }));
    }
  });

  if (q.isLoading) return <Skeleton className="h-40 w-full max-w-5xl" />;
  if (!o) return null;

  async function run<T>(body: Op, success?: string) {
    const r = await post<T>(projectId, body);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    if (success) toast.success(success);
    await qc.invalidateQueries({ queryKey: key });
    // une réponse peut modifier le projet (date de démarrage, tâche partagée) : le formulaire ci-dessous est relu
    router.refresh();
    return r.data;
  }

  return (
    <div className="mb-6 max-w-5xl space-y-4">
      <NextStep o={o} run={run} projectId={projectId} />
      <MissionView o={o} run={run} projectId={projectId} />
    </div>
  );
}

type Run = <T>(body: Op, success?: string) => Promise<T | null>;

// Bloc « Préparer l'onboarding » ----------------------------------------------------------------

function NextStep({ o, run, projectId }: { o: Onboarding; run: Run; projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const open = o.items.filter((i) => i.status === "open");
  const required = open.filter((i) => i.required);
  const optional = open.filter((i) => !i.required);
  const done = o.items.filter((i) => i.status === "answered" && i.answered_by === "client");
  const sharedRequests = o.items.filter((i) => i.status === "open" && i.request_shared_at);

  async function relaunch() {
    setBusy(true);
    await run({ op: "prepare" }, "Préparation relancée : vos corrections sont conservées");
    setBusy(false);
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-bold">Préparer l&apos;onboarding</h2>
        <Badge tone={ONBOARDING_STATUS_TONES[o.status]}>{o.status === "preparing" && <Spinner />} {ONBOARDING_STATUS_LABELS[o.status]}</Badge>
        <span className="text-xs text-muted">Vente du {formatDate(o.won_at)} · interne, le client ne voit rien de ce bloc</span>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={relaunch}><RefreshCw size={13} /> Relancer la préparation</Button>
      </div>

      {o.prep_state === "failed" && (
        <p className="flex items-start gap-2 rounded-lg bg-danger/5 p-2 text-sm text-danger"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {o.prep_error ?? "La préparation a échoué."} La vente et le projet sont bien enregistrés.</p>
      )}
      {o.status === "preparing" && <p className="text-sm text-muted">Le projet est déjà utilisable. Les éléments arrivent au fil de la préparation.</p>}

      <Analysis o={o} run={run} projectId={projectId} />

      {o.status === "ready" ? (
        <Ready o={o} run={run} projectId={projectId} />
      ) : required.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">{required.length === 1 ? "1 point bloque le démarrage" : `${required.length} points bloquent le démarrage`}</p>
          <ol className="space-y-2">{required.map((i, n) => <ItemRow key={i.id} item={i} index={n + 1} o={o} run={run} projectId={projectId} />)}</ol>
        </div>
      ) : null}

      {sharedRequests.length > 0 && <p className="text-xs text-muted">{sharedRequests.length} demande(s) partagée(s) sur le portail, en attente de réponse du client.</p>}
      {done.length > 0 && <p className="text-xs text-success">{done.length} réponse(s) reçue(s) du client : relisez-les ci-dessous ou dans les points traités.</p>}

      {optional.length > 0 && (
        <div>
          <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink" onClick={() => setShowOptional(!showOptional)}>
            <ChevronDown size={14} className={cn(showOptional && "rotate-180")} /> Compléments facultatifs ({optional.length})
          </button>
          {showOptional && <ul className="mt-2 space-y-2">{optional.map((i) => <ItemRow key={i.id} item={i} o={o} run={run} projectId={projectId} />)}</ul>}
        </div>
      )}
      <Treated o={o} run={run} projectId={projectId} />
    </Card>
  );
}

function Analysis({ o, run, projectId }: { o: Onboarding; run: Run; projectId: string }) {
  const [busy, setBusy] = useState(false);
  if (o.analysis_state === "done" && !o.analysis_error) return null;
  const hasSources = o.proposal_file_id || o.sections.context?.items.length || o.diagnostic_id;
  if (!hasSources) return null;
  if (o.analysis_state === "requested" && !o.analysis_error) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Sparkles size={14} className="text-violet" /> Claude analyse la proposition, les appels et le diagnostic
        {o.analysis_requested_at && <> (lancé le {formatDateTime(o.analysis_requested_at)})</>}.
        {o.analysis_session_url && <a className="font-semibold text-violet-strong underline" href={o.analysis_session_url} target="_blank" rel="noreferrer noopener">Suivre</a>}
      </p>
    );
  }
  const prompt = analysisPrompt(projectId);
  return (
    <div className="space-y-2 rounded-lg border border-violet-line bg-violet-soft/40 p-3 text-sm">
      <p>
        <Sparkles size={14} className="mr-1 inline text-violet" />
        Le CRM ne lit pas le contenu des documents. Pour préremplir objectifs, périmètre et livrables, faites analyser les sources par Claude.
      </p>
      {o.analysis_error && <p className="text-danger">Dernier essai : {o.analysis_error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {o.analysis_auto && (
          <Button size="sm" variant="primary" disabled={busy} onClick={async () => { setBusy(true); await run({ op: "analyze" }, "Analyse demandée à Claude"); setBusy(false); }}>
            <Sparkles size={13} /> Lancer l&apos;analyse
          </Button>
        )}
        <a href={claudeLink(prompt)} target="_blank" rel="noreferrer noopener" className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold", o.analysis_auto ? "border border-line bg-white" : "bg-ink text-white hover:bg-violet-strong")}>
          <ExternalLink size={13} /> Analyser dans Claude
        </a>
        <Button size="sm" variant="ghost" onClick={async () => { await navigator.clipboard.writeText(prompt); toast.success("Message copié"); }}><Copy size={13} /> Copier le message</Button>
      </div>
    </div>
  );
}

function Ready({ o, run, projectId }: { o: Onboarding; run: Run; projectId: string }) {
  const [busy, setBusy] = useState(false);
  const pending = o.decks.find((d) => d.status === "requested" || d.status === "uploading");
  const ready = o.decks.filter((d) => d.status === "ready");
  async function generate() {
    setBusy(true);
    const r = await run<{ version: number; triggered: boolean; existing: boolean; error?: string }>({ op: "deck" });
    setBusy(false);
    if (!r) return;
    if (r.error) toast.error(`Version ${r.version} demandée, mais Claude n'a pas pu être lancé : ${r.error}`);
    else if (r.triggered) toast.success(`Version ${r.version} en cours de génération`);
    else if (!r.existing) toast.success(`Version ${r.version} demandée : ouvrez Claude pour la générer`);
  }
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm"><Check size={15} className="text-success" /> Les éléments nécessaires au démarrage sont réunis. Relisez la mission ci-dessous, corrigez si besoin, puis générez les slides.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !!pending} onClick={generate}>
          <Sparkles size={14} /> {ready.length ? "Générer une nouvelle version des slides" : "Générer les slides d'onboarding"}
        </Button>
        <a href="#mission" className="text-sm font-semibold text-muted hover:text-ink">Relire avant de générer</a>
      </div>
      {pending && <DeckPending deck={pending} auto={o.deck_auto} projectId={projectId} />}
      {o.decks.some((d) => d.status === "failed") && !pending && <p className="text-sm text-danger">Dernière génération échouée : {o.decks.find((d) => d.status === "failed")?.error}. Relancez.</p>}
      {ready.length > 0 && <Decks decks={ready} o={o} run={run} projectId={projectId} />}
    </div>
  );
}

function DeckPending({ deck, auto, projectId }: { deck: OnboardingDeck; auto: boolean; projectId: string }) {
  const prompt = slidesPrompt(projectId);
  if (auto && deck.session_url) {
    return <p className="text-sm text-muted"><Spinner /> Version {deck.version} en cours de génération par Claude. <a className="font-semibold text-violet-strong underline" href={deck.session_url} target="_blank" rel="noreferrer noopener">Suivre</a></p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Version {deck.version} demandée. Elle arrivera ici dès que Claude l&apos;aura déposée.</span>
      <a href={claudeLink(prompt)} target="_blank" rel="noreferrer noopener" className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-semibold text-white hover:bg-violet-strong"><ExternalLink size={13} /> Générer dans Claude</a>
      <Button size="sm" variant="ghost" onClick={async () => { await navigator.clipboard.writeText(prompt); toast.success("Message copié"); }}><Copy size={13} /> Copier le message</Button>
    </div>
  );
}

function Decks({ decks, o, run, projectId }: { decks: OnboardingDeck[]; o: Onboarding; run: Run; projectId: string }) {
  const [confirm, setConfirm] = useState<OnboardingDeck | null>(null);
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {decks.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <FileText size={15} className="text-muted" />
          <span className="font-semibold">Slides d&apos;onboarding V{d.version}</span>
          <span className="text-xs text-muted">{d.ready_at && formatDateTime(d.ready_at)}</span>
          {d.shared_at ? <Badge tone="violet">Partagée avec le client</Badge> : <Badge>Interne</Badge>}
          <span className="ml-auto flex gap-1">
            {d.file_id && <Button size="sm" onClick={() => openDocument(projectId, d.file_id!)}><Download size={13} /> Télécharger</Button>}
            {d.shared_at
              ? <Button size="sm" variant="ghost" onClick={() => run({ op: "deck_share", deck: d.id, share: false }, "Version retirée du partage")}>Ne plus partager</Button>
              : <Button size="sm" onClick={() => setConfirm(d)}><Send size={13} /> Partager cette version</Button>}
          </span>
        </li>
      ))}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={`Partager la V${confirm?.version ?? ""} avec le client ?`}>
        <div className="space-y-3 text-sm">
          <p>Le fichier passe à la racine des fichiers du projet. {o.portal_published ? "Les contacts du projet le verront sur le portail." : "Il sera visible des contacts dès que le projet sera publié sur le portail."} Les autres versions restent internes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button variant="primary" onClick={async () => { if (confirm && (await run({ op: "deck_share", deck: confirm.id, share: true }, `V${confirm.version} partagée`)) !== null) setConfirm(null); }}>Partager</Button>
          </div>
        </div>
      </Modal>
    </ul>
  );
}

async function openDocument(projectId: string, fileId: string) {
  const r = await post<{ url: string }>(projectId, { op: "document_url", file: fileId });
  if (!r.ok) return toast.error(r.error);
  window.open(r.data.url, "_blank", "noopener,noreferrer");
}

// Un point à traiter ----------------------------------------------------------------------------

function ItemRow({ item: i, index, o, run, projectId }: { item: OnboardingItem; index?: number; o: Onboarding; run: Run; projectId: string }) {
  const [text, setText] = useState("");
  const [date, setDate] = useState(o.start_date ?? "");
  const [doc, setDoc] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function answer(action: string, value: string | null = null, file: string | null = null, success = "Point mis à jour") {
    setBusy(true);
    await run({ op: "answer", item: i.id, action, value, file }, success);
    setBusy(false);
  }

  async function upload(f: File) {
    setBusy(true);
    const s = await post<{ file_id: string; signedUrl: string }>(projectId, { op: "upload_start", item: i.id, name: f.name, type: f.type || "application/octet-stream", size: f.size });
    if (!s.ok) {
      setBusy(false);
      return toast.error(s.error);
    }
    const put = await fetch(s.data.signedUrl, { method: "PUT", headers: { "content-type": f.type || "application/octet-stream" }, body: f }).catch(() => null);
    if (!put?.ok) {
      setBusy(false);
      return toast.error("Le fichier n'a pas pu être envoyé. Réessayez.");
    }
    await run({ op: "upload_confirm", item: i.id, file: s.data.file_id }, "Document importé et rattaché");
    setBusy(false);
  }

  const options = i.kind === "proposal" && i.options.length ? i.options : null;
  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start gap-2">
        {index && <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ink font-label text-[11px] font-bold text-white">{index}</span>}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{i.label}</p>
          {i.detail && <p className="text-sm text-muted">{i.detail}</p>}
          {i.origin === "claude" && <p className="text-[11px] text-muted">Point soulevé par Claude</p>}
          <Refs refs={i.refs} o={o} projectId={projectId} />
          {i.request_shared_at && <p className="mt-1 text-xs text-violet-strong">Demande partagée sur le portail le {formatDateTime(i.request_shared_at)} · en attente du client</p>}
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer("not_applicable", null, null, "Point marqué non applicable")}>Non applicable</Button>
      </div>

      {i.kind === "proposal" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={doc} onChange={(e) => setDoc(e.target.value)} className="h-8 max-w-xs text-sm" aria-label="Document de la fiche">
            <option value="">{options ? "Choisir la proposition acceptée…" : "Choisir un document déjà joint…"}</option>
            {(options ?? o.documents.map((d) => ({ label: d.display_name, file_id: d.id }))).map((d) => <option key={d.file_id} value={d.file_id}>{d.label}</option>)}
          </Select>
          <Button size="sm" variant="primary" disabled={!doc || busy} onClick={() => answer("file", null, doc, "Proposition retenue")}>Utiliser</Button>
          <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={13} /> Importer le document signé</Button>
          <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        </div>
      )}
      {i.kind === "date" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 w-44" aria-label="Date" />
          <Button size="sm" variant="primary" disabled={!date || busy} onClick={() => answer(i.key === "start_date" ? "date" : "text", date, null, "Date enregistrée")}>Enregistrer la date</Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Demander au client</Button>
        </div>
      )}
      {(i.kind === "text" || i.kind === "client_request") && (
        <div className="space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={i.kind === "client_request" ? "Réponse ou information déjà connue (facultatif)" : "Votre réponse (une ligne par élément)"} className="min-h-16" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => answer("text", text, null, "Réponse enregistrée")}>Enregistrer</Button>
            <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={13} /> Joindre un fichier</Button>
            <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            <Button size="sm" variant={i.kind === "client_request" ? "primary" : "ghost"} onClick={() => setAsking(true)}><Send size={13} /> {i.request_shared_at ? "Modifier la demande au client" : "Préparer une demande au client"}</Button>
          </div>
        </div>
      )}
      {(i.kind === "choice" || i.kind === "conflict") && (
        <div className="grid gap-2 sm:grid-cols-2">
          {i.options.map((opt) => (
            <button key={opt.label} type="button" disabled={busy} onClick={() => answer("choice", opt.label, null, "Choix enregistré")} className="rounded-lg border border-line p-2 text-left text-sm hover:border-violet hover:bg-violet-soft">
              <span className="font-semibold">{opt.label}</span>
              {opt.text && <span className="block text-muted">{opt.text}</span>}
              <Refs refs={opt.refs ?? []} o={o} projectId={projectId} />
            </button>
          ))}
        </div>
      )}
      {(i.kind === "contact" || i.kind === "link") && (
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/fiches/${o.company_id}`} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold hover:border-violet">
            <ExternalLink size={13} /> {i.kind === "contact" ? "Compléter sur la fiche" : "Ouvrir la fiche"}
          </Link>
          <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); await run({ op: "prepare" }, "Sources vérifiées à nouveau"); setBusy(false); }}>J&apos;ai complété : vérifier</Button>
        </div>
      )}
      <RequestModal open={asking} onClose={() => setAsking(false)} item={i} o={o} run={run} />
    </li>
  );
}

function RequestModal({ open, onClose, item: i, o, run }: { open: boolean; onClose: () => void; item: OnboardingItem; o: Onboarding; run: Run }) {
  const [text, setText] = useState(i.request_text ?? [i.label, i.detail].filter(Boolean).join("\n"));
  const [person, setPerson] = useState(o.members[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Demande au client">
      <div className="space-y-3 text-sm">
        <p className="text-muted">Relisez la demande. Une fois partagée, elle apparaît comme une tâche dans le portail du client : il pourra y répondre ou déposer le fichier demandé. Rien n&apos;est envoyé par email.</p>
        <Field label="Texte visible du client"><Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-28" maxLength={5000} /></Field>
        {o.members.length > 0 && (
          <Field label="Destinataire">
            <Select value={person} onChange={(e) => setPerson(e.target.value)}>
              {o.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              <option value="">Toute l&apos;équipe client</option>
            </Select>
          </Field>
        )}
        {!o.portal_published && <p className="rounded-lg bg-amber-50 p-2 text-warning">Le projet n&apos;est pas encore publié sur le portail : publiez-le dans le formulaire ci-dessous avant de partager.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={busy || !text.trim() || !o.portal_published} onClick={async () => {
            setBusy(true);
            const r = await run({ op: "request", item: i.id, text, person: person || null }, "Demande partagée sur le portail");
            setBusy(false);
            if (r !== null) onClose();
          }}>
            <Send size={14} /> Partager sur le portail
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Treated({ o, run, projectId }: { o: Onboarding; run: Run; projectId: string }) {
  const [show, setShow] = useState(false);
  const treated = o.items.filter((i) => i.status === "answered" || i.status === "not_applicable");
  if (!treated.length) return null;
  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink" onClick={() => setShow(!show)}>
        <ChevronDown size={14} className={cn(show && "rotate-180")} /> Points traités ({treated.length})
      </button>
      {show && (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {treated.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm">
              <Check size={14} className="mt-0.5 text-success" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{i.label}</p>
                <p className="text-muted">
                  {i.status === "not_applicable" ? "Non applicable" : i.answer}
                  {i.answered_by === "client" && <Badge tone="violet" className="ml-1">Reçu du client</Badge>}
                </p>
                {i.answer_file_id && <button type="button" className="text-xs font-semibold text-violet-strong underline" onClick={() => openDocument(projectId, i.answer_file_id!)}>Ouvrir le document</button>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => run({ op: "answer", item: i.id, action: "reopen" }, "Point rouvert")}>Modifier</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Vue projet -------------------------------------------------------------------------------------

function MissionView({ o, run, projectId }: { o: Onboarding; run: Run; projectId: string }) {
  const proposal = o.documents.find((d) => d.id === o.proposal_file_id);
  return (
    <div id="mission" className="grid gap-3 lg:grid-cols-2">
      {MAIN.map((k) => <SectionCard key={k} k={k} o={o} run={run} projectId={projectId} />)}
      <Card className="space-y-2 p-4">
        <h3 className="font-display text-sm font-bold">Interlocuteurs</h3>
        {o.contacts.length ? (
          <ul className="space-y-1 text-sm">
            {o.contacts.map((c) => (
              <li key={c.id}>
                <span className="font-semibold">{c.name}</span>{c.title && <span className="text-muted"> · {c.title}</span>}{c.is_primary && <Badge className="ml-1">Principal</Badge>}
                <span className="block text-xs text-muted">{[c.email, c.phone].filter(Boolean).join(" · ") || "Coordonnées à compléter"}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Aucun contact sur la fiche.</p>}
        <Link href={`/fiches/${o.company_id}`} className="text-xs font-semibold text-muted hover:text-ink">Modifier sur la fiche →</Link>
      </Card>
      <Card className="space-y-2 p-4">
        <h3 className="font-display text-sm font-bold">Sources utilisées</h3>
        <ul className="space-y-1 text-sm">
          <li>Proposition : {proposal ? <button type="button" className="font-semibold text-violet-strong underline" onClick={() => openDocument(projectId, proposal.id)}>{proposal.display_name}</button> : <span className="text-muted">aucune retenue</span>}</li>
          <li>Appels Fireflies : <span className="text-muted">{o.sections.context?.items.filter((x) => x.refs?.some((r) => r.kind === "call")).length || "aucun"} résumé(s)</span></li>
          <li>Diagnostic : <span className="text-muted">{o.diagnostic_id ? "dernier diagnostic avec une version prête" : "aucun"}</span></li>
          <li className="text-xs text-muted">Le CRM lit les résumés et transcriptions Fireflies et le texte du diagnostic. Le contenu des documents (PDF, Word, PowerPoint) n&apos;est lu que par Claude, lors de l&apos;analyse.</li>
        </ul>
      </Card>
      {CONTEXT.map((k) => o.sections[k]?.items.length ? <SectionCard key={k} k={k} o={o} run={run} projectId={projectId} /> : null)}
    </div>
  );
}

const toLines = (items: SectionItem[]) => items.map((x) => (x.date ? `${x.text} | ${x.date}${x.date_status === "provisional" ? " (provisoire)" : ""}` : x.text)).join("\n");

/** Une ligne par élément ; les éléments inchangés gardent leurs références. Phases : « Nom | AAAA-MM-JJ (provisoire) ». */
function fromLines(text: string, before: SectionItem[], phases: boolean): SectionItem[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const same = before.find((b) => toLines([b]) === line);
    if (same) return { ...same, suggested: false };
    if (!phases) return { text: line };
    const m = line.match(/^(.*?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*(\(provisoire\))?$/);
    if (!m) return { text: line, date: null, date_status: "unknown" };
    return { text: m[1], date: m[2] ?? null, date_status: m[2] ? (m[3] ? "provisional" : "confirmed") : "unknown" };
  });
}

function SectionCard({ k, o, run, projectId }: { k: SectionKey; o: Onboarding; run: Run; projectId: string }) {
  const s = o.sections[k];
  const items = s?.items ?? [];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-sm font-bold">{SECTION_TITLES[k]}</h3>
        {s && items.length > 0 && <span className="text-[11px] text-muted">{ORIGIN_LABELS[s.origin]}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setText(toLines(items)); setEditing(!editing); }}><Pencil size={12} /> Corriger</Button>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-24 text-sm" placeholder={k === "phases" ? "Une phase par ligne : Audit | 2026-12-01 (provisoire)" : "Un élément par ligne"} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={async () => { if ((await run({ op: "section", key: k, items: fromLines(text, items, k === "phases") }, "Section enregistrée : elle ne sera plus remplacée")) !== null) setEditing(false); }}>Enregistrer</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Annuler</Button>
          </div>
        </div>
      ) : items.length ? (
        <ul className="space-y-1.5 text-sm">
          {items.map((x, n) => (
            <li key={n} className="flex gap-1.5">
              <span className="text-muted">•</span>
              <span className="min-w-0 flex-1">
                {x.text}
                {k === "phases" && <span className="text-muted"> · {x.date ? `${formatDate(x.date)}${x.date_status === "provisional" ? " (provisoire)" : ""}` : "date à définir"}</span>}
                {x.suggested && <Badge className="ml-1">Suggestion</Badge>}
                {x.provisional && <Badge tone="warning" className="ml-1">Provisoire</Badge>}
                <Refs refs={x.refs ?? []} o={o} projectId={projectId} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{k === "phases" ? "Phases et dates à définir." : "À compléter."}</p>
      )}
    </Card>
  );
}

function Refs({ refs, o, projectId }: { refs: SourceRef[]; o: Onboarding; projectId: string }) {
  const shown = refs.filter((r) => r.kind !== "answer");
  if (!shown.length) return null;
  const label = (r: SourceRef) => (r.kind === "call" && r.at != null ? `${r.label ?? "Appel"} · ${Math.floor(r.at / 60)} min ${Math.round(r.at % 60)} s` : r.label || { file: "Document", call: "Appel", diagnostic: "Diagnostic", company: "Fiche", answer: "Réponse" }[r.kind]);
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {shown.map((r, n) => {
        const cls = "inline-flex items-center gap-0.5 rounded border border-line px-1 text-[10px] font-semibold text-muted hover:border-violet hover:text-ink";
        const title = r.excerpt ? `« ${r.excerpt} »` : undefined;
        if (r.kind === "file" && r.id) return <button key={n} type="button" title={title} className={cls} onClick={(e) => { e.stopPropagation(); void openDocument(projectId, r.id!); }}><FileText size={10} /> {label(r)}</button>;
        return <Link key={n} href={`/fiches/${o.company_id}`} title={title} className={cls} onClick={(e) => e.stopPropagation()}>{label(r)}</Link>;
      })}
    </span>
  );
}
