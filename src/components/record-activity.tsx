"use client";

// Onglet Activité : une seule timeline filtrable. Les traces techniques restent dans le journal des modifications.
import { useState } from "react";
import { History, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { setTaskDoneAction } from "@/app/actions";
import { attempt } from "@/lib/client/query";
import { ACTIVITY_FILTERS, buildJournal, matchesFilter, openTasks, type ActivityEntry, type ActivityFilter } from "@/lib/crm/record-activity";
import { CHANNEL_LABELS, KIND_LABELS, formatDateTime, personName } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { EntryRow, Provenance, useActivityEntries } from "./record-entry";
import { TaskRow } from "./record-tasks";
import { Badge, Button, Modal, Skeleton, cn } from "./ui";

const EMPTY: Record<ActivityFilter, string> = {
  all: "Rien pour l'instant.",
  note: "Aucune note.",
  email: "Aucun email ni message.",
  call: "Aucun appel.",
  meeting: "Aucun rendez-vous.",
  task: "Aucune tâche.",
};

export function RecordActivity({ ctx }: { ctx: RecordCtx }) {
  const { entries, loading, failed, retry } = useActivityEntries(ctx, true);
  const [journal, setJournal] = useState(false);
  const filter = ctx.filter;
  const tasks = filter === "all" || filter === "task" ? openTasks(ctx.detail.tasks) : [];
  const shown = entries.filter((e) => matchesFilter(e, filter));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filtrer l'activité">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => ctx.setFilter(f.key)}
            className={cn("rounded-full border px-2.5 py-1 font-label text-xs font-semibold", filter === f.key ? "border-ink bg-ink text-white" : "border-line bg-white text-muted hover:text-ink")}
          >
            {f.label}
          </button>
        ))}
        <button type="button" onClick={() => setJournal(true)} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink">
          <History size={12} /> Journal des modifications
        </button>
      </div>

      {failed && (
        <p className="mt-3 text-sm text-danger">
          Une partie de l&apos;activité n&apos;a pas pu être chargée. <button type="button" className="underline" onClick={retry}>Réessayer</button>
        </p>
      )}

      {tasks.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 font-label text-xs font-bold tracking-wide text-muted uppercase">À faire</h3>
          <div className="space-y-2">
            {tasks.map((t) => <TaskRow key={t.id} task={t} personLabel={personName(ctx.detail.people.find((p) => p.id === t.person_id))} onChanged={ctx.reload} />)}
          </div>
        </section>
      )}
      {filter === "task" && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={ctx.newTask}><Plus size={14} /> Créer une tâche</Button>
      )}

      <ol className="mt-3 -mx-2 divide-y divide-line/60">
        {shown.map((e) => <li key={e.key}><Row entry={e} ctx={ctx} /></li>)}
        {loading && [0, 1, 2].map((i) => <li key={i} className="px-2 py-2"><Skeleton className="h-12 w-full" /></li>)}
      </ol>
      {!shown.length && !loading && !tasks.length && <p className="mt-3 text-sm text-muted">{EMPTY[filter]}</p>}

      {journal && <Journal ctx={ctx} onClose={() => setJournal(false)} />}
    </div>
  );
}

function Row({ entry, ctx }: { entry: ActivityEntry; ctx: RecordCtx }) {
  if (entry.task) return <DoneTask entry={entry} ctx={ctx} />;
  return <EntryRow entry={entry} ctx={ctx} />;
}

function DoneTask({ entry, ctx }: { entry: ActivityEntry; ctx: RecordCtx }) {
  const task = entry.task!;
  const person = personName(ctx.detail.people.find((p) => p.id === task.person_id));
  async function reopen() {
    const r = await attempt(() => setTaskDoneAction(task.id, false));
    if (!r.ok) return toast.error(r.error);
    await ctx.reload();
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-muted line-through">{task.title}</p>
        <p className="text-xs text-muted">Terminée le {formatDateTime(task.done_at)}{person && ` · ${person}`}</p>
      </div>
      <Badge tone="success">Terminée</Badge>
      <Button size="sm" variant="ghost" onClick={reopen}><RotateCcw size={12} /> Rouvrir</Button>
    </div>
  );
}

const TABLE_LABELS: Record<string, string> = {
  companies: "fiche",
  people: "personne",
  interactions: "historique",
  tasks: "tâche",
  list_members: "liste",
  campaign_participants: "campagne",
};
const OP_LABELS: Record<string, string> = { INSERT: "ajout", UPDATE: "modification", DELETE: "suppression" };

function Journal({ ctx, onClose }: { ctx: RecordCtx; onClose: () => void }) {
  const items = buildJournal(ctx.detail.interactions, ctx.detail.claudeLog);
  return (
    <Modal open onClose={onClose} title="Journal des modifications" wide>
      {!items.length && <p className="text-sm text-muted">Aucune modification enregistrée.</p>}
      <ol className="space-y-2">
        {items.map(({ key, at, interaction: i, log: l }) => (
          <li key={key} className="text-sm">
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span className="font-semibold text-ink">{i ? KIND_LABELS[i.kind] : "Claude"}</span>
              <span>· {formatDateTime(at)}</span>
              {i?.channel && <span>· {CHANNEL_LABELS[i.channel]}</span>}
              {i && <Provenance source={i.source} origin={i.content_origin} />}
            </p>
            {i?.content && <p className="text-muted">{i.content}</p>}
            {l && <p className="text-muted">{OP_LABELS[l.operation] ?? l.operation} ({TABLE_LABELS[l.table_name] ?? l.table_name}){l.summary ? ` : ${l.summary}` : ""}</p>}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
