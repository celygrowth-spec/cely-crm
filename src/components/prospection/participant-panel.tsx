"use client";

// Panneau latéral d'un participant : personne ciblée, avancement étape par étape,
// brouillons personnalisés (≠ modèle, ≠ envoyé), résultat et actions de suivi.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Ban, Check, ExternalLink, RotateCcw, X } from "lucide-react";
import {
  recordReplyAction, saveDraftAction, setDoNotContactAction, setOutcomeAction, updateParticipantsAction,
} from "@/app/prospection-actions";
import type { Person } from "@/lib/crm/types";
import { formatDate, formatDateTime, localInputToISO, nowLocalInput, personName, relativeDay } from "@/lib/format";
import type { CampaignStep, Conflict, Draft, ParticipantRow } from "@/lib/prospection/service";
import { STEP_META, renderTemplate, variableLabel } from "@/lib/prospection/steps";
import { contextFor, targetPerson } from "@/lib/prospection/workspace";
import { useCrm } from "../app-shell";
import { Badge, Button, Field, Input, Select, Spinner, Textarea, cn } from "../ui";
import { ExecBadge, OutcomeBadge, StepIcon } from "./bits";

export function ParticipantPanel({
  p, steps, people, drafts, conflicts, onClose,
}: {
  p: ParticipantRow; steps: CampaignStep[]; people: Person[]; drafts: Draft[]; conflicts: Conflict[]; onClose: () => void;
}) {
  const router = useRouter();
  const { openCompany, pipelines } = useCrm();
  const companyPeople = people.filter((x) => x.company_id === p.company_id);
  const person = targetPerson(p, people);
  const [reply, setReply] = useState("");
  const [replyAt, setReplyAt] = useState(nowLocalInput());
  const [stage, setStage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = p.status === "a_contacter" || p.status === "en_cours";

  async function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, msg: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-ink/20" aria-label="Fermer" onClick={onClose} />
      <section className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-white shadow-2xl" role="dialog" aria-modal="true">
        <header className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <button onClick={() => openCompany(p.company_id)} className="flex items-center gap-1 font-display text-lg font-bold hover:text-violet-strong">
              {p.company.name} <ExternalLink size={13} />
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <ExecBadge status={p.status} />
              <OutcomeBadge outcome={p.outcome} />
              {p.company.do_not_contact && <Badge tone="danger"><Ban size={10} /> Ne plus contacter</Badge>}
              {p.next_due_date && active && <Badge tone={p.next_due_date < new Date().toISOString().slice(0, 10) ? "danger" : "neutral"}>Échéance {relativeDay(p.next_due_date)}</Badge>}
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface" aria-label="Fermer"><X size={18} /></button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <Field label="Personne ciblée" hint="Change la personne pour les étapes à venir ; les échanges passés gardent leur destinataire réel.">
            <Select
              value={p.person_id ?? ""}
              disabled={busy || p.status === "termine" || p.status === "arrete"}
              onChange={(e) => act(() => updateParticipantsAction([p.id], "set_person", { reason: e.target.value || null }), "Personne ciblée modifiée")}
            >
              <option value="">— Aucune —</option>
              {companyPeople.map((x) => (
                <option key={x.id} value={x.id}>
                  {personName(x)}{x.title ? ` · ${x.title}` : ""}{x.email ? " · email" : ""}{x.linkedin_url ? " · LinkedIn" : ""}
                </option>
              ))}
            </Select>
          </Field>

          {conflicts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={14} className="text-warning" /> Aussi sollicitée ailleurs</p>
              {conflicts.map((c) => (
                <p key={c.other_participant_id} className="text-xs">
                  {c.other_campaign_name} · {c.other_status === "a_repondu" ? "a répondu" : "en cours"} · dernière prise de contact {c.other_last_done_at ? formatDate(c.other_last_done_at) : "—"}
                </p>
              ))}
            </div>
          )}

          <section>
            <h3 className="mb-2 font-label text-xs font-bold text-muted uppercase">Séquence · version {p.sequence_version}</h3>
            <ol className="space-y-2">
              {steps.map((s) => (
                <StepRow key={s.position} p={p} s={s} person={person} draft={drafts.find((d) => d.participant_id === p.id && d.sequence_version === p.sequence_version && d.step_position === s.position)} />
              ))}
            </ol>
          </section>

          <section className="space-y-2">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Réponse et résultat</h3>
            {p.status !== "arrete" && p.status !== "a_preparer" && (
              <div className="rounded-lg border border-line p-2">
                <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder="Coller la réponse reçue…" />
                <div className="mt-1.5 flex items-center gap-2">
                  <Input type="datetime-local" value={replyAt} onChange={(e) => setReplyAt(e.target.value)} className="h-8 w-52" aria-label="Reçue le" />
                  <Button size="sm" className="ml-auto" disabled={busy || !reply.trim()} onClick={() => act(() => recordReplyAction(p.id, reply, localInputToISO(replyAt), p.person_id), "Réponse enregistrée : relances de l'entreprise suspendues").then(() => setReply(""))}>
                    Enregistrer la réponse
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Select value={stage} onChange={(e) => setStage(e.target.value)} className="h-8 w-auto max-w-56 text-xs" aria-label="Pipeline et étape">
                <option value="">Intéressé — sans pipeline</option>
                {pipelines.map((pl) => (
                  <optgroup key={pl.id} label={pl.name}>
                    {pl.stages.map((s) => <option key={s.id} value={s.id}>{pl.name} › {s.name}</option>)}
                  </optgroup>
                ))}
              </Select>
              <Button size="sm" disabled={busy} onClick={() => act(() => setOutcomeAction(p.id, "interested", stage || null), stage ? "Intéressé : fiche placée dans le pipeline" : "Marqué intéressé")}>Intéressé</Button>
              <Button size="sm" disabled={busy} onClick={() => act(() => setOutcomeAction(p.id, "meeting"), "Rendez-vous obtenu")}>RDV obtenu</Button>
              <Button size="sm" disabled={busy} onClick={() => { if (confirm("Pas intéressé : la prospection de cette entreprise s'arrête. Continuer ?")) act(() => setOutcomeAction(p.id, "not_interested"), "Prospection arrêtée"); }}>Pas intéressé</Button>
              <Button size="sm" variant="danger" disabled={busy || p.company.do_not_contact} onClick={() => { const r = prompt("Ne plus contacter cette entreprise ? Motif (facultatif) :"); if (r !== null) act(() => setOutcomeAction(p.id, "do_not_contact", null, r), "Marquée « Ne plus contacter »"); }}>
                <Ban size={12} /> Ne plus contacter
              </Button>
              {p.company.do_not_contact && (
                <Button size="sm" variant="ghost" onClick={() => act(() => setDoNotContactAction(p.company_id, false), "« Ne plus contacter » retiré")}>Retirer le blocage</Button>
              )}
            </div>
          </section>

          <section className="flex flex-wrap gap-1.5 border-t border-line pt-3">
            {p.status === "a_preparer" && <Button size="sm" variant="ghost" onClick={() => act(() => updateParticipantsAction([p.id], "unprepare"), "Retiré de la campagne")}>Retirer de la campagne</Button>}
            {active && <Button size="sm" onClick={() => act(() => updateParticipantsAction([p.id], "stop", { reason: "Arrêt manuel" }), "Suivi arrêté")}>Arrêter le suivi</Button>}
            {(p.status === "a_repondu" || p.status === "arrete") && !p.company.do_not_contact && (
              <Button size="sm" onClick={() => act(() => updateParticipantsAction([p.id], "resume"), "Suivi repris")}><RotateCcw size={12} /> Reprendre la séquence</Button>
            )}
            {p.status === "a_repondu" && <Button size="sm" variant="ghost" onClick={() => act(() => updateParticipantsAction([p.id], "finish"), "Séquence terminée")}>Terminer</Button>}
            {busy && <Spinner />}
          </section>
          {p.stop_reason && p.status === "arrete" && <p className="text-xs text-muted">Arrêt : {p.stop_reason}</p>}
        </div>
      </section>
    </div>
  );
}

function StepRow({ p, s, person, draft }: { p: ParticipantRow; s: CampaignStep; person: Person | null; draft?: Draft }) {
  const meta = STEP_META[s.step_type];
  const done = p.status !== "a_preparer" && s.position < p.current_step;
  const current = s.position === p.current_step && (p.status === "a_contacter" || p.status === "en_cours" || p.status === "a_preparer");
  const ctx = contextFor(p, person);
  const editable = meta.hasMessage && !done && p.status !== "arrete" && p.status !== "termine";
  const [open, setOpen] = useState(current && editable);
  return (
    <li className={cn("rounded-lg border", current ? "border-violet" : "border-line", done && "bg-surface/60")}>
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="font-label text-[11px] font-bold text-muted">{s.position}</span>
        <StepIcon type={s.step_type} size={12} />
        <span className="flex-1 truncate text-sm font-semibold">{s.name}</span>
        {draft && <Badge tone="violet">Personnalisé</Badge>}
        {done ? <Badge tone="success"><Check size={10} /> Fait</Badge> : current ? <Badge tone="ink">{p.status === "a_preparer" ? "1re étape" : "Étape actuelle"}</Badge> : <span className="font-label text-[10px] text-muted">+{s.delay_days} j</span>}
      </button>
      {open && editable && <DraftEditor p={p} s={s} draft={draft} ctx={ctx} />}
      {open && !meta.hasMessage && s.instructions && <p className="px-2 pb-2 text-xs text-muted">{s.instructions}</p>}
    </li>
  );
}

/** Brouillon personnalisé enregistré automatiquement ; survit au rechargement. */
export function DraftEditor({ p, s, draft, ctx }: { p: ParticipantRow; s: CampaignStep; draft?: Draft; ctx: ReturnType<typeof contextFor> }) {
  const meta = STEP_META[s.step_type];
  const rendered = { subject: renderTemplate(s.subject, ctx), body: renderTemplate(s.message, ctx) };
  const [subject, setSubject] = useState(draft?.subject ?? rendered.subject.text);
  const [body, setBody] = useState(draft?.body ?? rendered.body.text);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(draft ? "saved" : "idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  // enregistrement automatique : déclenché par la saisie, jamais par l'affichage
  function change(next: { subject?: string; body?: string }) {
    const sub = next.subject ?? subject;
    const bod = next.body ?? body;
    if (next.subject !== undefined) setSubject(sub);
    if (next.body !== undefined) setBody(bod);
    if (timer.current) clearTimeout(timer.current);
    setState("saving");
    timer.current = setTimeout(async () => {
      const r = await saveDraftAction(p.id, s.position, meta.hasSubject ? sub : null, bod);
      setState(r.ok ? "saved" : "error");
      if (!r.ok) toast.error(r.error);
    }, 700);
  }

  const missing = [...new Set([...renderTemplate(subject, ctx).missing, ...renderTemplate(body, ctx).missing, ...(subject + body).match(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g)?.map((t) => t.replace(/[{}\s]/g, "")) ?? []])];

  return (
    <div className="space-y-1.5 border-t border-line px-2 py-2">
      {meta.hasSubject && <Input value={subject} onChange={(e) => change({ subject: e.target.value })} placeholder="Objet" className="h-8" />}
      <Textarea value={body} onChange={(e) => change({ body: e.target.value })} rows={5} />
      <div className="flex items-center gap-2 text-[11px]">
        {missing.length > 0 ? (
          <span className="flex items-center gap-1 text-warning"><AlertTriangle size={11} /> À compléter : {missing.map(variableLabel).join(", ")}</span>
        ) : (
          <span className="text-muted">Prêt</span>
        )}
        <span className="ml-auto text-muted">
          {state === "saving" ? "Enregistrement…" : state === "saved" ? `Brouillon enregistré${draft ? ` · ${formatDateTime(draft.updated_at)}` : ""}` : state === "error" ? "Échec de l'enregistrement" : "Modèle (non personnalisé)"}
        </span>
        {(draft || state === "saved") && (
          <button
            className="text-violet-strong hover:underline"
            onClick={async () => {
              const r = await saveDraftAction(p.id, s.position, null, null);
              if (!r.ok) return toast.error(r.error);
              if (timer.current) clearTimeout(timer.current);
              setSubject(rendered.subject.text);
              setBody(rendered.body.text);
              setState("idle");
              router.refresh();
            }}
          >
            Revenir au modèle
          </button>
        )}
      </div>
    </div>
  );
}
