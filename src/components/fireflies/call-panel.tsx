"use client";

// Détail d'un appel : description, note interne, rattachement, transcription chargée à l'ouverture.
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarDays, ExternalLink } from "lucide-react";
import { useSync } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { actionItems, formatCallDuration, keyPoints, summaryText } from "@/lib/fireflies/transcript-view";
import type { Call } from "@/lib/fireflies/types";
import { post } from "./api";
import { CallStateBadge } from "./call-list";
import { CompanyPicker } from "./company-picker";
import { Transcript } from "./transcript";
import { Button, Modal, Textarea } from "../ui";

const SOURCE_LABELS: Record<NonNullable<Call["link_source"]>, string> = {
  appointment: "rattaché par son rendez-vous",
  email: "rattaché par l'email d'un contact",
  manual: "votre choix",
};

export const CALL_KEYS = [["fireflies-calls"], ["fireflies-to-link"], ["fireflies-status"]] as const;

export function CallPanel({ call, onClose }: { call: Call; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={call.title} wide>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>{formatDateTime(call.occurred_at) || "Date inconnue"}</span>
        {formatCallDuration(call.duration_minutes) && <span>· {formatCallDuration(call.duration_minutes)}</span>}
        <CallStateBadge call={call} />
        {call.transcript_url && (
          <a href={call.transcript_url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 font-semibold text-violet-strong hover:underline">
            Ouvrir dans Fireflies <ExternalLink size={13} />
          </a>
        )}
      </div>
      {call.participants.length > 0 && <p className="mt-1 text-xs break-words text-muted">Participants : {call.participants.join(", ")}</p>}

      <div className="mt-5 grid gap-6">
        <section>
          <SectionTitle>Description de l&apos;appel</SectionTitle>
          <Description call={call} />
        </section>
        <NoteBox key={call.internal_note ?? ""} call={call} />
        <LinkBox call={call} />
        <section>
          <SectionTitle>Transcription complète</SectionTitle>
          <Transcript callId={call.id} lineCount={call.line_count} />
        </section>
      </div>
    </Modal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 font-label text-xs font-bold tracking-wide text-muted uppercase">{children}</h3>;
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="mb-0.5 text-xs font-semibold text-ink">{title}</p>
      <p className="break-words whitespace-pre-line">{text}</p>
    </div>
  );
}

function Description({ call }: { call: Call }) {
  const main = summaryText(call.summary);
  const actions = actionItems(call.summary);
  const points = keyPoints(call.summary);
  if (!main && !actions && !points) {
    return (
      <p className="text-sm text-muted">
        {call.summary_state === "pending"
          ? "Résumé en attente : Fireflies ne l'a pas encore produit. Il s'ajoutera ici tout seul."
          : "Fireflies n'a pas produit de résumé pour cet appel."}
      </p>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      {main && <Block title="Résumé Fireflies" text={main} />}
      {actions && <Block title="Prochaines actions" text={actions} />}
      {points && <Block title="Points clés" text={points} />}
    </div>
  );
}

function NoteBox({ call }: { call: Call }) {
  const sync = useSync();
  const [note, setNote] = useState(call.internal_note ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = note !== (call.internal_note ?? "");
  async function save() {
    setBusy(true);
    const r = await post(`/api/fireflies/calls/${call.id}/note`, { note });
    setBusy(false);
    if (!r.ok) return toast.error(r.error, { action: { label: "Réessayer", onClick: save } });
    toast.success("Note enregistrée");
    sync(...CALL_KEYS);
  }
  return (
    <section>
      <label htmlFor={`call-note-${call.id}`} className="mb-2 block font-label text-xs font-bold tracking-wide text-muted uppercase">Note interne</label>
      <Textarea id={`call-note-${call.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={20000} placeholder="Votre note, distincte du résumé Fireflies et conservée aux imports suivants" />
      <div className="mt-1 flex justify-end">
        <Button size="sm" type="button" variant="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer la note"}</Button>
      </div>
    </section>
  );
}

function LinkBox({ call }: { call: Call }) {
  const sync = useSync();
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  async function act(body: object, done: string) {
    setBusy(true);
    const r = await post(`/api/fireflies/calls/${call.id}/link`, body);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(done);
    setMoving(false);
    sync(...CALL_KEYS);
  }
  return (
    <section>
      <SectionTitle>Rattachement</SectionTitle>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {call.company_id ? (
          <>
            <Link href={`/fiches/${call.company_id}`} className="font-semibold text-violet-strong hover:underline">{call.company_name ?? "Fiche"}</Link>
            {call.link_source && <span className="text-xs text-muted">({SOURCE_LABELS[call.link_source]})</span>}
          </>
        ) : call.link_state === "ignored" ? (
          <span className="text-muted">Appel ignoré</span>
        ) : (
          <span className="text-muted">À rattacher{call.link_reason ? ` : ${call.link_reason}` : ""}</span>
        )}
        <div className="ml-auto flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" type="button" onClick={() => setMoving((m) => !m)}>{call.company_id ? "Déplacer" : "Rattacher"}</Button>
          {call.link_state !== "ignored" && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => act({ action: "ignore" }, "Appel ignoré")}>Ignorer</Button>}
          {call.link_source === "manual" && <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => act({ action: "reset" }, "Choix annulé")}>Annuler mon choix</Button>}
        </div>
      </div>
      {call.booking_id && (
        <Link href={`/rendez-vous/liste?periode=tous&rdv=${call.booking_id}`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-violet-strong hover:underline">
          <CalendarDays size={14} /> Voir le rendez-vous
        </Link>
      )}
      {moving && <div className="mt-2"><CompanyPicker disabled={busy} onPick={(id) => act({ action: "link", company_id: id }, "Appel rattaché")} /></div>}
    </section>
  );
}
