import Link from "next/link";
import { PhoneCall, Zap } from "lucide-react";
import { ChannelChip, StepIcon } from "@/components/prospection/bits";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { listTodo } from "@/lib/crm/service";
import { inboxCounts } from "@/lib/lemlist/inbox";
import type { TodoItem } from "@/lib/crm/types";
import { addDaysISO, formatDate, relativeDay, todayISO } from "@/lib/format";
import type { StepType } from "@/lib/prospection/steps";
import { STEP_META } from "@/lib/prospection/steps";
import { TasksList } from "./_today/tasks-list";

// « Aujourd'hui » (E1, K01, Q01) : le point d'entrée de la journée. Relances de prospection (avec Focus), tâches CRM et
// tâches de projet qui me sont attribuées, réponses à traiter et appels à rattacher. Une seule source (todo_items),
// la même que le compteur du menu et la « prochaine action » des fiches.
const VIEWS = [
  { key: "jour", label: "Aujourd'hui et en retard" },
  { key: "semaine", label: "7 prochains jours" },
  { key: "tout", label: "Tout, échéances futures comprises" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ vue?: string }> }) {
  const { supabase } = await requireOwner();
  const { vue } = await searchParams;
  const view: View = vue === "semaine" || vue === "tout" ? vue : "jour";
  const today = todayISO();
  const [items, counters, lemlist] = await Promise.all([
    listTodo(supabase), supabase.rpc("nav_counters", { p_today: today }),
    inboxCounts(supabase).catch(() => ({ unread: 0, awaiting: 0 })), // Messages lemlist : lu au CRM, aucun appel à lemlist ici
  ]);
  const c = (counters.data ?? {}) as { replies?: number; calls?: number; emails?: number };
  const until = view === "jour" ? today : view === "semaine" ? addDaysISO(today, 7) : null;
  const inView = (i: TodoItem) => (until ? i.due_date != null && i.due_date <= until : true);
  const followups = items.filter((i) => i.item_type === "followup" && inView(i));
  const tasks = items.filter((i) => i.item_type !== "followup" && inView(i));
  const late = followups.filter((i) => i.due_date < today);
  const due = followups.filter((i) => i.due_date === today);
  const later = followups.filter((i) => i.due_date > today);
  const focusCount = late.length + due.length;
  const byCampaign = new Map<string, { name: string; n: number }>();
  [...late, ...due].forEach((i) => byCampaign.set(i.campaign_id!, { name: i.campaign_name!, n: (byCampaign.get(i.campaign_id!)?.n ?? 0) + 1 }));
  const lateTasks = tasks.filter((t) => t.due_date != null && t.due_date < today).length;

  const Row = ({ i }: { i: TodoItem }) => (
    <li className="group flex items-center gap-2 px-3 py-2 text-sm hover:bg-violet-soft/30">
      <StepIcon type={(i.step_type ?? "task") as StepType} size={12} />
      <span className="min-w-0 flex-1 truncate">
        <strong>{i.company_name}</strong>
        {i.person_name && <span className="text-muted"> · {i.person_name}</span>}
        <span className="text-muted"> — {i.title}</span>
      </span>
      <span className="hidden text-xs text-muted md:inline">{STEP_META[(i.step_type ?? "task") as StepType].label} · étape {i.step_position}/{i.step_count}</span>
      <Link href={`/prospection/campagnes/${i.campaign_id}`} className="hidden max-w-40 truncate text-xs text-muted hover:text-violet-strong lg:inline">{i.campaign_name}</Link>
      <span className={i.due_date < today ? "w-24 text-right text-xs font-bold text-danger" : "w-24 text-right text-xs text-muted"}>{relativeDay(i.due_date)}</span>
      <Link href={`/prospection/focus?depart=${i.id}`} className="rounded-md px-2 py-1 text-xs font-semibold text-violet-strong opacity-0 group-hover:opacity-100 hover:bg-white focus:opacity-100">Traiter</Link>
    </li>
  );

  return (
    <div className="max-w-5xl" data-today>
      <PageHeader
        title="Aujourd'hui"
        description={`${formatDate(today)} · ${late.length + lateTasks} en retard · ${due.length + tasks.filter((t) => t.due_date === today).length} pour aujourd'hui`}
        actions={
          focusCount > 0 ? (
            <Link href="/prospection/focus" className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 font-semibold text-white hover:bg-violet-strong">
              <Zap size={16} /> Relances en mode Focus ({focusCount})
            </Link>
          ) : undefined
        }
      />

      <nav aria-label="Période" className="mb-4 flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <Link key={v.key} href={v.key === "jour" ? "/" : `/?vue=${v.key}`} aria-current={view === v.key ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${view === v.key ? "border-ink bg-ink text-white" : "border-line text-muted hover:text-ink"}`}>
            {v.label}
          </Link>
        ))}
      </nav>

      {((c.replies ?? 0) > 0 || (c.calls ?? 0) > 0 || (c.emails ?? 0) > 0 || lemlist.unread > 0) && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          {(c.replies ?? 0) > 0 && (
            <Link href="/prospection/reponses" className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm hover:border-amber-300" data-today-replies>
              <span><strong>{c.replies} réponse(s) à traiter</strong> : intéressé, rendez-vous, pas intéressé ou reprise.</span>
              <span className="shrink-0 pl-2 font-semibold whitespace-nowrap">Ouvrir →</span>
            </Link>
          )}
          {lemlist.unread > 0 && (
            <Link href="/messages" className="flex items-center justify-between rounded-xl border border-violet/30 bg-violet-soft px-4 py-2.5 text-sm hover:border-violet" data-today-messages>
              <span><strong>{lemlist.unread} nouvelle(s) réponse(s) lemlist</strong> sur les comptes de vos clients.</span>
              <span className="shrink-0 pl-2 font-semibold whitespace-nowrap">Ouvrir →</span>
            </Link>
          )}
          {(c.emails ?? 0) > 0 && (
            <Link href="/mail/a-rattacher" className="flex items-center justify-between rounded-xl border border-line px-4 py-2.5 text-sm hover:border-violet" data-today-emails>
              <span><strong>{c.emails} email(s) reçu(s) à rattacher</strong> : l&apos;adresse correspond à plusieurs fiches.</span>
              <span className="shrink-0 pl-2 font-semibold whitespace-nowrap">Ouvrir →</span>
            </Link>
          )}
          {(c.calls ?? 0) > 0 && (
            <Link href="/appels" className="flex items-center justify-between rounded-xl border border-line px-4 py-2.5 text-sm hover:border-violet" data-today-calls>
              <span><PhoneCall size={14} className="mr-1 inline" aria-hidden /><strong>{c.calls} appel(s) à rattacher</strong> à une fiche.</span>
              <span className="shrink-0 pl-2 font-semibold whitespace-nowrap">Ouvrir →</span>
            </Link>
          )}
        </div>
      )}

      {byCampaign.size > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <span className="text-xs text-muted">Focus par campagne :</span>
          {[...byCampaign].map(([id, x]) => (
            <Link key={id} href={`/prospection/focus?campagne=${id}`} className="rounded-full border border-line px-2.5 py-0.5 text-xs font-semibold hover:border-violet hover:bg-violet-soft">
              {x.name} · {x.n}
            </Link>
          ))}
        </div>
      )}

      {!followups.length && !tasks.length ? (
        <EmptyState
          title={view === "jour" ? "Rien d'urgent aujourd'hui" : "Rien à faire sur cette période"}
          description="Relances de campagne, tâches des fiches et tâches de projet qui vous sont attribuées apparaissent ici à leur échéance."
          action={view !== "tout" ? <Link href="/?vue=tout" className="font-semibold text-violet-strong">Voir toutes les échéances →</Link> : undefined}
        />
      ) : (
        <div className="space-y-5">
          {tasks.length > 0 && (
            <section data-today-tasks>
              <h2 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">Tâches · {tasks.length}</h2>
              <TasksList tasks={tasks} />
            </section>
          )}
          {([["Relances en retard", late, true], ["Relances du jour", due, false], ["Relances à venir", later, false]] as const).map(([title, list, isLate]) =>
            list.length ? (
              <section key={title}>
                <h2 className={`mb-1.5 font-label text-xs font-bold uppercase ${isLate ? "text-danger" : "text-muted"}`}>{title} · {list.length}</h2>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {list.map((i) => <Row key={i.id} i={i} />)}
                </ul>
              </section>
            ) : null,
          )}
          {focusCount > 0 && (
            <p className="text-xs text-muted">
              Canaux du jour : {[...new Set([...late, ...due].map((i) => i.channel ?? "other"))].map((ch) => <span key={ch} className="mr-1"><ChannelChip channel={ch} /></span>)}
              {" "}Les campagnes en pause ne sont pas proposées.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
