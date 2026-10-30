import Link from "next/link";
import { Zap } from "lucide-react";
import { ChannelChip, StepIcon } from "@/components/prospection/bits";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { listTodo } from "@/lib/crm/service";
import { addDaysISO, formatDate, relativeDay, todayISO } from "@/lib/format";
import type { StepType } from "@/lib/prospection/steps";
import { STEP_META } from "@/lib/prospection/steps";
import { TasksBlock } from "./tasks-block";

// File du jour : étapes de prospection dues (campagnes actives) et tâches manuelles, sans doublon.
export default async function AujourdhuiPage() {
  const { supabase } = await requireOwner();
  const today = todayISO();
  const [items, replies] = await Promise.all([
    listTodo(supabase),
    supabase.from("campaign_participants").select("id", { count: "exact", head: true }).eq("status", "a_repondu").in("outcome", ["none", "replied"]),
  ]);
  const followups = items.filter((i) => i.item_type === "followup");
  const tasks = items.filter((i) => i.item_type === "task" && i.due_date <= addDaysISO(today, 7));
  const late = followups.filter((i) => i.due_date < today);
  const due = followups.filter((i) => i.due_date === today);
  const soon = followups.filter((i) => i.due_date > today && i.due_date <= addDaysISO(today, 7));
  const byCampaign = new Map<string, { name: string; n: number }>();
  [...late, ...due].forEach((i) => byCampaign.set(i.campaign_id!, { name: i.campaign_name!, n: (byCampaign.get(i.campaign_id!)?.n ?? 0) + 1 }));
  const total = late.length + due.length;

  const Row = ({ i }: { i: (typeof followups)[number] }) => (
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
    <div className="max-w-5xl">
      <PageHeader
        title="Aujourd'hui"
        description={`${formatDate(today)} · ${late.length} en retard · ${due.length} pour aujourd'hui · ${soon.length} dans les 7 jours`}
        actions={
          total > 0 ? (
            <Link href="/prospection/focus" className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 font-semibold text-white hover:bg-violet-strong">
              <Zap size={16} /> Commencer la session ({total})
            </Link>
          ) : undefined
        }
      />

      {(replies.count ?? 0) > 0 && (
        <Link href="/prospection/reponses" className="mb-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm hover:border-amber-300">
          <span><strong>{replies.count} réponse(s) à traiter</strong> : décidez de la suite (intéressé, rendez-vous, pas intéressé, reprise).</span>
          <span className="font-semibold">Ouvrir →</span>
        </Link>
      )}

      {byCampaign.size > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <span className="text-xs text-muted">Session par campagne :</span>
          {[...byCampaign].map(([id, c]) => (
            <Link key={id} href={`/prospection/focus?campagne=${id}`} className="rounded-full border border-line px-2.5 py-0.5 text-xs font-semibold hover:border-violet hover:bg-violet-soft">
              {c.name} · {c.n}
            </Link>
          ))}
        </div>
      )}

      {!followups.length && !tasks.length ? (
        <EmptyState
          title="Rien à faire pour l'instant"
          description="Les étapes de vos campagnes actives et vos tâches apparaîtront ici à leur échéance."
          action={<Link href="/prospection/campagnes" className="font-semibold text-violet-strong">Voir les campagnes →</Link>}
        />
      ) : (
        <div className="space-y-5">
          {[["En retard", late, true], ["Aujourd'hui", due, false], ["Dans les 7 prochains jours", soon, false]].map(([title, list, isLate]) =>
            (list as typeof followups).length ? (
              <section key={title as string}>
                <h2 className={`mb-1.5 font-label text-xs font-bold uppercase ${isLate ? "text-danger" : "text-muted"}`}>{title as string} · {(list as typeof followups).length}</h2>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {(list as typeof followups).map((i) => <Row key={i.id} i={i} />)}
                </ul>
              </section>
            ) : null,
          )}
          {tasks.length > 0 && <TasksBlock tasks={tasks} />}
          <p className="text-xs text-muted">
            Canaux du jour : {[...new Set([...late, ...due].map((i) => i.channel ?? "other"))].map((c) => <span key={c} className="mr-1"><ChannelChip channel={c} /></span>)}
            {" "}Les campagnes en pause ne sont pas proposées.
          </p>
        </div>
      )}
    </div>
  );
}
