"use client";

// Onglet Aperçu : prochaine action, prochain rendez-vous, contexte, derniers échanges. Ce qui manque reste discret.
import { useState } from "react";
import { CalendarClock, Check, ExternalLink } from "lucide-react";
import { DEFAULT_TZ, formatRange } from "@/lib/appointments/time";
import { nextBooking, openTasks, recentExchanges } from "@/lib/crm/record-activity";
import type { Task } from "@/lib/crm/types";
import { PROSPECT_STATUS_LABELS, formatDate, personName, relativeDay } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { EntryRow, useActivityEntries } from "./record-entry";
import { PostponeButtons, useTaskActions } from "./record-tasks";
import { RecordTodos } from "./todo/record-todos";
import { Badge, Button, Skeleton, cn } from "./ui";

export function RecordOverview({ ctx }: { ctx: RecordCtx }) {
  const { entries, bookings, loading } = useActivityEntries(ctx, false);
  const tasks = openTasks(ctx.detail.tasks);
  const booking = nextBooking(bookings);
  const exchanges = recentExchanges(entries);

  return (
    <div className="grid gap-5">
      <section aria-label="Prochaine action">
        {tasks[0] ? (
          <NextAction key={tasks[0].id} task={tasks[0]} ctx={ctx} others={tasks.length - 1} />
        ) : (
          <p className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-sm text-muted">
            Aucune action prévue.
            <Button size="sm" className="ml-auto" onClick={ctx.newTask}>Créer une tâche</Button>
          </p>
        )}
      </section>

      <RecordTodos companyId={ctx.detail.company.id} />

      {booking && (
        <section className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm">
          <CalendarClock size={16} className="shrink-0 text-violet-strong" />
          <div className="min-w-0 flex-1">
            <p className="font-label text-xs font-bold text-muted">Prochain rendez-vous</p>
            <p className="font-semibold">{formatRange(booking.starts_at, booking.ends_at, DEFAULT_TZ)}</p>
          </div>
          {booking.meeting_url && (
            <a href={booking.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-violet-strong hover:underline">
              Rejoindre <ExternalLink size={12} />
            </a>
          )}
        </section>
      )}

      <Context ctx={ctx} />

      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">Derniers échanges</h3>
          {exchanges.length > 0 && <button type="button" className="text-xs font-semibold text-violet-strong hover:underline" onClick={() => ctx.go("activity")}>Tout voir dans Activité</button>}
        </div>
        {loading && !exchanges.length && <div className="grid gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>}
        {!loading && !exchanges.length && <p className="text-sm text-muted">Aucun échange pour l&apos;instant.</p>}
        <div className="-mx-2">
          {exchanges.map((e) => <EntryRow key={e.key} entry={e} ctx={ctx} />)}
        </div>
      </section>
    </div>
  );
}

function NextAction({ task, ctx, others }: { task: Task; ctx: RecordCtx; others: number }) {
  const { done, due, late, today, complete, postpone } = useTaskActions(task, ctx.reload);
  const person = personName(ctx.detail.people.find((p) => p.id === task.person_id));
  return (
    <div className={cn("row-in rounded-xl border p-3 transition-opacity duration-150", late ? "border-danger/30 bg-danger/5" : "border-violet-line bg-violet-soft/40", done && "opacity-50")}>
      <p className="font-label text-xs font-bold text-muted">Prochaine action</p>
      <p className={cn("mt-0.5 font-semibold break-words", done && "line-through")}>{task.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Badge tone={late ? "danger" : due === today ? "violet" : "neutral"} className={cn(late && "font-bold")}>{late ? "En retard · " : ""}{relativeDay(due)}</Badge>
        {relativeDay(due) !== formatDate(due) && <span>{formatDate(due)}</span>}
        {person && <span>· {person}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="primary" onClick={complete} disabled={done}><Check size={13} /> Terminer</Button>
        <span className="ml-1 text-xs text-muted">Reporter :</span>
        <PostponeButtons onPostpone={postpone} />
        {others > 0 && (
          <button type="button" className="ml-auto text-xs font-semibold text-violet-strong hover:underline" onClick={() => ctx.go("activity", { filter: "task" })}>
            Voir toutes les tâches ({others + 1})
          </button>
        )}
      </div>
    </div>
  );
}

/** Au-delà, le texte risque de dépasser les trois lignes affichées. */
const LONG_CONTEXT = 120;

function Context({ ctx }: { ctx: RecordCtx }) {
  const c = ctx.detail.company;
  const [open, setOpen] = useState(false);
  const edit = () => ctx.go("details", { section: "company", edit: true });
  const statusLabel = c.pipeline_id ? PROSPECT_STATUS_LABELS[c.prospect_status] : null;
  if (!c.description) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <span>Aucun besoin renseigné{c.source ? ` · Source : ${c.source.name}` : ""}.</span>
        <button type="button" className="text-xs font-semibold text-violet-strong hover:underline" onClick={edit}>Ajouter</button>
      </p>
    );
  }
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">Contexte prospect</h3>
        {c.source && <span className="text-xs text-muted">· {c.source.name}</span>}
        {statusLabel && <span className="text-xs text-muted">· {statusLabel}</span>}
      </div>
      <p className={cn("text-sm break-words whitespace-pre-line", !open && "line-clamp-3")}>{open ? c.description : c.description.replace(/\n\s*\n/g, "\n")}</p>
      <div className="mt-0.5 flex gap-3 text-xs font-semibold text-violet-strong">
        {c.description.length > LONG_CONTEXT && <button type="button" className="hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Réduire" : "Lire la suite"}</button>}
        <button type="button" className="hover:underline" onClick={edit}>Modifier</button>
      </div>
    </section>
  );
}
