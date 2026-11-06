"use client";

// Note ou échange ajouté à la main, ouvert depuis les actions de l'en-tête.
import { useState } from "react";
import { toast } from "sonner";
import { addInteractionAction } from "@/app/actions";
import { attempt } from "@/lib/client/query";
import type { Channel } from "@/lib/crm/types";
import { CHANNEL_LABELS, KIND_LABELS, localInputToISO, nowLocalInput, personName } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { Button, Input, Select, Textarea, cn } from "./ui";

export const LOG_KINDS = ["note", "message_out", "message_in", "call", "meeting"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export function LogForm({ ctx, initial, onDone }: { ctx: RecordCtx; initial: LogKind; onDone: () => void }) {
  const { people, company } = ctx.detail;
  const [kind, setKind] = useState<LogKind>(initial);
  const [channel, setChannel] = useState<Channel | "">("");
  const [personId, setPersonId] = useState("");
  const [at, setAt] = useState(nowLocalInput());
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await attempt(() => addInteractionAction(
      {
        company_id: company.id,
        kind,
        content,
        occurred_at: localInputToISO(at),
        person_id: personId || null,
        channel: kind === "note" ? null : channel || (kind === "call" ? "phone" : null),
      },
      key,
    ));
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.paused_followups) toast.info(`Réponse enregistrée : ${res.data.paused_followups} relance(s) mise(s) en pause.`);
    else toast.success("Ajouté à l'historique");
    await ctx.reload();
    onDone();
  }

  return (
    <form onSubmit={submit}>
      {initial !== "note" && (
        <div className="mb-2 flex flex-wrap gap-1">
          {LOG_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "rounded-full border px-2.5 py-1 font-label text-xs font-semibold",
                kind === k ? "border-ink bg-ink text-white" : "border-line bg-white text-muted hover:text-ink",
              )}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
        placeholder={kind === "note" ? "Note interne (non envoyée au prospect)" : kind === "message_in" ? "Message reçu du prospect" : kind === "message_out" ? "Texte réellement envoyé" : "Compte rendu"}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-52" aria-label="Date de l'échange" />
        {kind !== "note" && (
          <Select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="w-36" aria-label="Canal">
            <option value="">Canal —</option>
            {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        )}
        {people.length > 0 && (
          <Select value={personId} onChange={(e) => setPersonId(e.target.value)} className="w-40" aria-label="Personne">
            <option value="">Personne —</option>
            {people.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
          </Select>
        )}
        <Button type="submit" variant="primary" className="ml-auto" disabled={pending || (["note", "message_out", "message_in"].includes(kind) && !content.trim())}>
          Ajouter
        </Button>
      </div>
    </form>
  );
}
