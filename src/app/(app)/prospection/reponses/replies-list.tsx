"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Ban, CalendarCheck, Play, ThumbsDown, ThumbsUp } from "lucide-react";
import { setOutcomeAction, updateParticipantsAction } from "@/app/prospection-actions";
import { useCrm } from "@/components/app-shell";
import { Button, EmptyState, PageHeader } from "@/components/ui";
import { NextStepFields, defaultNext, toNextStep, type NextChoice } from "@/components/prospection/next-step";
import type { Interaction, Person } from "@/lib/crm/types";
import { CHANNEL_LABELS, formatDateTime, personName } from "@/lib/format";

export type ReplyRow = {
  id: string;
  company_id: string;
  person_id: string | null;
  status: string;
  outcome: string;
  current_step: number;
  updated_at: string;
  campaign: { id: string; name: string };
  company: { id: string; name: string; do_not_contact: boolean };
  reply: Interaction | null;
  person: Person | null;
};

export function RepliesList({ rows }: { rows: ReplyRow[] }) {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Réponses à traiter"
        description="Réponses que vous avez enregistrées et dont la suite reste à décider. Les relances de ces entreprises sont suspendues."
      />
      {!rows.length ? (
        <EmptyState title="Aucune réponse en attente" description="Quand vous enregistrez une réponse sans décider de la suite, elle apparaît ici." />
      ) : (
        <ul className="space-y-2">{rows.map((r) => <ReplyCard key={r.id} r={r} />)}</ul>
      )}
    </div>
  );
}

function ReplyCard({ r }: { r: ReplyRow }) {
  const router = useRouter();
  const { openCompany } = useCrm();
  // « Intéressé » et « RDV obtenu » : toujours une suite (Q04), enregistrée une fois (K06)
  const [outcome, setOutcome] = useState<"interested" | "meeting" | null>(null);
  const [suite, setSuite] = useState<NextChoice>(() => defaultNext("interested", r.company.name));
  const [key] = useState(() => crypto.randomUUID()); // la carte disparaît une fois le résultat enregistré
  const pick = (o: "interested" | "meeting") => { setOutcome(o); setSuite(defaultNext(o, r.company.name)); };
  const [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(msg);
    router.refresh();
  }
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <button className="font-semibold hover:text-violet-strong" onClick={() => openCompany(r.company_id)}>{r.company.name}</button>
        {r.person && <span className="text-sm text-muted">{personName(r.person)}</span>}
        <span className="text-xs text-muted">· {r.campaign.name}</span>
        {r.reply && <span className="ml-auto text-xs text-muted">{r.reply.channel ? `${CHANNEL_LABELS[r.reply.channel]} · ` : ""}{formatDateTime(r.reply.occurred_at)}</span>}
      </div>
      {r.reply?.content && <p className="mt-1.5 rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-wrap">{r.reply.content}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={outcome === "interested" ? "primary" : "secondary"} disabled={busy} onClick={() => pick("interested")}><ThumbsUp size={12} /> Intéressé…</Button>
        <Button size="sm" variant={outcome === "meeting" ? "primary" : "secondary"} disabled={busy} onClick={() => pick("meeting")}><CalendarCheck size={12} /> RDV obtenu…</Button>
        <Button size="sm" disabled={busy} onClick={() => act(() => setOutcomeAction(r.id, "not_interested"), "Pas intéressé · prospection arrêtée")}><ThumbsDown size={12} /> Pas intéressé</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => updateParticipantsAction([r.id], "resume"), "Relances reprises à partir d'aujourd'hui")}><Play size={12} /> Reprendre les relances</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const m = prompt("Ne plus contacter cette entreprise ? Motif (facultatif) :"); if (m !== null) act(() => setOutcomeAction(r.id, "do_not_contact", null, m), "Marquée « Ne plus contacter »"); }}>
          <Ban size={12} /> Ne plus contacter
        </Button>
      </div>
      {outcome && (
        <div className="mt-2 space-y-2" data-outcome-form>
          <NextStepFields value={suite} onChange={setSuite} outcome={outcome} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>Annuler</Button>
            <Button size="sm" variant="primary" disabled={busy}
              onClick={() => act(() => setOutcomeAction(r.id, outcome, null, null, toNextStep(suite), key), outcome === "meeting" ? "Rendez-vous obtenu : suite enregistrée" : "Intéressé : suite enregistrée")}>
              Enregistrer le résultat
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
