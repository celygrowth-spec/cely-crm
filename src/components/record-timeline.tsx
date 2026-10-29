"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Bot, Calendar, CheckCircle2, GitMerge, Inbox, Info, Phone, Send, StickyNote, Target } from "lucide-react";
import { addInteractionAction } from "@/app/actions";
import type { Channel, Interaction, InteractionKind } from "@/lib/crm/types";
import { CHANNEL_LABELS, formatDateTime, KIND_LABELS, localInputToISO, nowLocalInput, personName } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { Badge, Button, Input, Select, Textarea, cn } from "./ui";

const ICONS: Record<InteractionKind, typeof Send> = {
  note: StickyNote,
  message_out: Send,
  message_in: Inbox,
  call: Phone,
  meeting: Calendar,
  stage_change: ArrowRightLeft,
  deal_status: Target,
  prospecting: Target,
  task_done: CheckCircle2,
  merge: GitMerge,
  system: Info,
};

const COMPOSE_KINDS = ["note", "message_out", "message_in", "call", "meeting"] as const;

const TABLE_LABELS: Record<string, string> = {
  companies: "fiche",
  people: "personne",
  interactions: "historique",
  tasks: "tâche",
  list_members: "liste",
  campaign_participants: "campagne",
};
const OP_LABELS: Record<string, string> = { INSERT: "ajout", UPDATE: "modification", DELETE: "suppression" };

export function RecordTimeline({ ctx }: { ctx: RecordCtx }) {
  const { interactions, people, company, claudeLog } = ctx.detail;
  const [kind, setKind] = useState<(typeof COMPOSE_KINDS)[number]>("note");
  const [channel, setChannel] = useState<Channel | "">("");
  const [personId, setPersonId] = useState("");
  const [at, setAt] = useState(nowLocalInput());
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState<"all" | "exchanges" | "notes">("all");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await addInteractionAction(
      {
        company_id: company.id,
        kind,
        content,
        occurred_at: localInputToISO(at),
        person_id: personId || null,
        channel: kind === "note" ? null : channel || (kind === "call" ? "phone" : null),
      },
      crypto.randomUUID(),
    );
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.paused_followups) toast.info(`Réponse enregistrée : ${res.data.paused_followups} relance(s) mise(s) en pause.`);
    else toast.success("Ajouté à l'historique");
    setContent("");
    setAt(nowLocalInput());
    await ctx.reload();
  }

  type Item = { key: string; at: string; node: React.ReactNode; kind: InteractionKind | "claude" };
  const items: Item[] = [
    ...interactions.map((i) => ({ key: i.id, at: i.occurred_at, kind: i.kind, node: <Entry i={i} person={personName(people.find((p) => p.id === i.person_id))} /> })),
    ...claudeLog
      .filter((l) => l.table_name !== "interactions") // les interactions de Claude sont déjà affichées
      .map((l) => ({
        key: `log-${l.id}`,
        at: l.created_at,
        kind: "claude" as const,
        node: (
          <div className="flex gap-2 text-xs text-muted">
            <Bot size={14} className="mt-0.5 shrink-0 text-violet" />
            <span>
              Claude : {OP_LABELS[l.operation] ?? l.operation} ({TABLE_LABELS[l.table_name] ?? l.table_name}) · {formatDateTime(l.created_at)}
            </span>
          </div>
        ),
      })),
  ]
    .filter((it) =>
      filter === "all" ? true : filter === "notes" ? it.kind === "note" : ["message_out", "message_in", "call", "meeting"].includes(it.kind),
    )
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div>
      <form onSubmit={submit} className="rounded-xl border border-line bg-surface/50 p-3">
        <div className="mb-2 flex flex-wrap gap-1">
          {COMPOSE_KINDS.map((k) => (
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
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder={kind === "note" ? "Note interne (non envoyée au prospect)" : kind === "message_in" ? "Message reçu du prospect" : kind === "message_out" ? "Texte réellement envoyé" : "Compte rendu"}
          className="bg-white"
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

      <div className="mt-3 flex gap-1 text-xs">
        {([["all", "Tout"], ["exchanges", "Échanges"], ["notes", "Notes"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={cn("rounded-md px-2 py-1 font-semibold", filter === k ? "bg-violet-soft text-ink" : "text-muted")}>
            {l}
          </button>
        ))}
      </div>
      <ol className="mt-2 space-y-3 border-l border-line pl-4">
        {items.map((it) => <li key={it.key}>{it.node}</li>)}
        {!items.length && <li className="text-sm text-muted">Rien pour l&apos;instant.</li>}
      </ol>
    </div>
  );
}

function Entry({ i, person }: { i: Interaction; person: string }) {
  const Icon = ICONS[i.kind];
  const exchange = ["message_out", "message_in", "call", "meeting", "note"].includes(i.kind);
  const meta = i.meta as { campaign_name?: string; step_name?: string };
  return (
    <div className="relative">
      <span className={cn("absolute top-0.5 -left-[25px] rounded-full border border-line bg-white p-0.5", i.kind === "message_in" && "border-success/40 text-success", i.kind === "message_out" && "text-violet-strong")}>
        <Icon size={12} />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        <span className={cn("font-semibold", exchange ? "text-ink" : "")}>{KIND_LABELS[i.kind]}</span>
        {i.channel && <span>· {CHANNEL_LABELS[i.channel]}</span>}
        {person && <span>· {person}</span>}
        <span>· {formatDateTime(i.occurred_at)}</span>
        {meta.campaign_name && <span>· {meta.campaign_name}{meta.step_name ? ` › ${meta.step_name}` : ""}</span>}
        {i.source === "claude" && <Badge tone="violet"><Bot size={10} /> via Claude</Badge>}
        {i.source === "import" && <Badge>import</Badge>}
        {i.content_origin === "claude_suggestion" && <Badge tone="warning">Texte rédigé par Claude</Badge>}
      </div>
      {i.content && (
        <p className={cn("mt-1 text-sm whitespace-pre-wrap", exchange ? "rounded-lg bg-surface px-3 py-2" : "text-muted", i.kind === "note" && "border-l-2 border-amber-300 bg-amber-50/60")}>
          {i.content}
        </p>
      )}
    </div>
  );
}
