"use client";

// Actions manuelles sur un participant de campagne. Copier ≠ envoyer :
// seule l'action « Marquer comme envoyé » enregistre un envoi.
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Copy, Inbox, Pause, Play, Send, Square, Columns3 } from "lucide-react";
import {
  markStepSentAction,
  moveCompanyAction,
  recordReplyAction,
  updateParticipantAction,
} from "@/app/actions";
import type { CampaignStep, ParticipantStatus, Person } from "@/lib/crm/types";
import { addDaysISO, CHANNEL_LABELS, localInputToISO, nowLocalInput, personName, todayISO } from "@/lib/format";
import { useCrm } from "./app-shell";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

export type ParticipantLike = {
  id: string;
  company_id: string;
  company_name: string;
  person_id: string | null;
  status: ParticipantStatus;
  current_step: number;
  next_due_date: string | null;
  steps: CampaignStep[];
};

export function fillTemplate(msg: string | null | undefined, ctx: { firstName?: string | null; company?: string }) {
  return (msg ?? "")
    .replace(/\{\s*pr[ée]nom\s*\}/gi, ctx.firstName ?? "")
    .replace(/\{\s*entreprise\s*\}/gi, ctx.company ?? "");
}

export function ParticipantActions({
  p,
  people,
  onChanged,
  compact,
}: {
  p: ParticipantLike;
  people: Person[];
  onChanged: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { pipelines } = useCrm();
  const [modal, setModal] = useState<null | "send" | "reply" | "postpone" | "pipeline">(null);
  const step = p.steps.find((s) => s.position === p.current_step);
  const active = p.status === "a_contacter" || p.status === "en_cours";
  const person = people.find((x) => x.id === p.person_id);

  const [message, setMessage] = useState("");
  const [sentAt, setSentAt] = useState(nowLocalInput());
  const [personId, setPersonId] = useState(p.person_id ?? "");
  const [reply, setReply] = useState("");
  const [due, setDue] = useState(addDaysISO(todayISO(), 1));
  const [stageId, setStageId] = useState("");
  const [pending, setPending] = useState(false);
  const [idemKey, setIdemKey] = useState("");

  function openSend() {
    setMessage(fillTemplate(step?.message, { firstName: person?.first_name, company: p.company_name }));
    setSentAt(nowLocalInput());
    setPersonId(p.person_id ?? "");
    setIdemKey(crypto.randomUUID());
    setModal("send");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      toast.success("Message copié. Il n'est pas encore marqué comme envoyé.");
    } catch {
      toast.error("Copie impossible : sélectionnez le texte manuellement.");
    }
  }

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setPending(true);
    const res = await fn();
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(success);
    setModal(null);
    await onChanged();
  }

  const btn = compact ? "sm" : "sm";

  return (
    <div className="flex flex-wrap gap-1">
      {(active || p.status === "a_repondu") && step && (
        <Button size={btn} variant={active ? "primary" : "secondary"} onClick={openSend}>
          <Send size={13} /> {compact ? "Message" : `Étape ${step.position} : ${step.name}`}
        </Button>
      )}
      {p.status !== "termine" && p.status !== "arrete" && (
        <Button size={btn} onClick={() => { setReply(""); setSentAt(nowLocalInput()); setModal("reply"); }}>
          <Inbox size={13} /> Réponse reçue
        </Button>
      )}
      {active && (
        <Button size={btn} variant="ghost" onClick={() => { setDue(p.next_due_date ? addDaysISO(p.next_due_date, 2) : addDaysISO(todayISO(), 2)); setModal("postpone"); }}>
          <CalendarClock size={13} /> Reporter
        </Button>
      )}
      {(p.status === "a_repondu" || p.status === "arrete") && step && (
        <Button size={btn} variant="ghost" onClick={() => act(() => updateParticipantAction(p.id, "resume", { due: todayISO() }), "Suivi repris")}>
          <Play size={13} /> Reprendre
        </Button>
      )}
      {p.status === "a_repondu" && (
        <Button size={btn} variant="ghost" onClick={() => act(() => updateParticipantAction(p.id, "finish"), "Suivi terminé")}>
          <Square size={13} /> Terminer
        </Button>
      )}
      {(active || p.status === "a_repondu") && (
        <Button
          size={btn}
          variant="ghost"
          onClick={() => {
            if (confirm("Arrêter le suivi de prospection pour cette fiche ?")) act(() => updateParticipantAction(p.id, "stop", { reason: "Arrêt manuel" }), "Suivi arrêté");
          }}
        >
          <Pause size={13} /> Arrêter
        </Button>
      )}
      {pipelines.length > 0 && (
        <Button size={btn} variant="ghost" onClick={() => { setStageId(pipelines[0]?.stages[0]?.id ?? ""); setModal("pipeline"); }}>
          <Columns3 size={13} /> Pipeline
        </Button>
      )}

      <Modal open={modal === "send"} onClose={() => setModal(null)} title={step ? `Étape ${step.position} · ${step.name} (${CHANNEL_LABELS[step.channel]})` : "Message"} wide>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Modifiez le texte si besoin, copiez-le, envoyez-le vous-même sur {step ? CHANNEL_LABELS[step.channel] : "le canal"}, puis enregistrez l&apos;envoi.
          </p>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Personne ciblée">
              <Select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                <option value="">—</option>
                {people.map((x) => <option key={x.id} value={x.id}>{personName(x)}</option>)}
              </Select>
            </Field>
            <Field label="Envoyé le">
              <Input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={copy}><Copy size={14} /> Copier le message</Button>
            <Button
              variant="primary"
              disabled={pending || !message.trim()}
              onClick={() =>
                act(() => markStepSentAction(p.id, message, localInputToISO(sentAt), personId || null, idemKey), "Envoi enregistré dans l'historique")
              }
            >
              <Send size={14} /> Marquer comme envoyé
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={modal === "reply"} onClose={() => setModal(null)} title="Enregistrer une réponse reçue">
        <div className="space-y-3">
          <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={5} placeholder="Collez la réponse du prospect" autoFocus />
          <Field label="Reçue le"><Input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} /></Field>
          <p className="text-xs text-muted">Les relances de cette fiche seront mises en pause : vous déciderez de la suite.</p>
          <div className="flex justify-end">
            <Button variant="primary" disabled={pending || !reply.trim()} onClick={() => act(() => recordReplyAction(p.id, reply, localInputToISO(sentAt)), "Réponse enregistrée, relances en pause")}>
              Enregistrer la réponse
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={modal === "postpone"} onClose={() => setModal(null)} title="Reporter l'échéance">
        <div className="flex items-end gap-2">
          <Field label="Nouvelle date" className="flex-1"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Button variant="primary" disabled={pending || !due} onClick={() => act(() => updateParticipantAction(p.id, "postpone", { due }), "Échéance reportée")}>Reporter</Button>
        </div>
      </Modal>

      <Modal open={modal === "pipeline"} onClose={() => setModal(null)} title="Envoyer la fiche dans un pipeline">
        <div className="space-y-3">
          <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {pipelines.map((pl) => (
              <optgroup key={pl.id} label={pl.name}>
                {pl.stages.map((s) => <option key={s.id} value={s.id}>{pl.name} › {s.name}</option>)}
              </optgroup>
            ))}
          </Select>
          <p className="text-xs text-muted">Les relances de prospection actives de cette fiche seront arrêtées. Tout l&apos;historique reste consultable.</p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={pending || !stageId}
              onClick={() => act(() => moveCompanyAction(p.company_id, stageId, true), "Fiche envoyée dans le pipeline")}
            >
              Envoyer
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
