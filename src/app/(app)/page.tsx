import Link from "next/link";
import { AlertTriangle, ArrowRight, Zap } from "lucide-react";
import { BookingDetailHost } from "@/components/rdv/booking-detail";
import { BookingRow } from "@/components/rdv/booking-row";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { listBookings } from "@/lib/appointments/owner";
import { DEFAULT_TZ, addDaysKey, dayKey, zonedToUtc } from "@/lib/appointments/time";
import { listTodo } from "@/lib/crm/service";
import type { TodoItem } from "@/lib/crm/types";
import { homeKpis, invoicedIn, openInvoicesAt } from "@/lib/finance/calc";
import { monthEnd, monthStart } from "@/lib/finance/dates";
import { eur } from "@/lib/finance/money";
import { loadFinance } from "@/lib/finance/service";
import { formatDate, relativeDay, todayISO } from "@/lib/format";
import { inboxCounts } from "@/lib/lemlist/inbox";
import { listProjects } from "@/lib/projects/owner";
import { PROJECT_STATUS_LABELS } from "@/lib/projects/types";
import { journeyTodos } from "@/lib/journey/rules";
import { listJourney } from "@/lib/journey/service";
import { HomeCalls } from "./_today/home-calls";
import { JourneyActions } from "./_today/journey-actions";
import { TasksList } from "./_today/tasks-list";

// Accueil : ce qui compte en ouvrant Cely Growth. Finance du mois, clients en cours, et ce qui attend une action
// (appels à rattacher, rendez-vous du jour, relances dues, réponses, tâches de projet). Toutes les lectures partent
// en parallèle ; un bloc qui échoue n'empêche pas les autres de s'afficher.
const ACTIVE = new Set(["a_preparer", "en_cours", "en_attente"]);
type Next = { label: string; date: string };

function Block({ title, href, children, ...rest }: { title: string; href?: string; children: React.ReactNode } & Record<`data-${string}`, boolean>) {
  return (
    <Card className="min-w-0 p-4" {...rest}>
      <h2 className="mb-3 flex items-baseline justify-between font-display text-base font-bold text-ink">
        {title}
        {href && <Link href={href} className="inline-flex items-center gap-1 font-sans text-xs font-semibold text-violet-strong hover:underline">Ouvrir <ArrowRight size={12} aria-hidden /></Link>}
      </h2>
      {children}
    </Card>
  );
}
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted" data-empty>{children}</p>;
const ok = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), () => ({ ok: false as const, v: null }));

export default async function HomePage() {
  const { supabase } = await requireOwner();
  const today = todayISO();
  const day = dayKey(new Date(), DEFAULT_TZ);
  const [todo, counters, lemlist, finance, projects, milestones, ptasks, bookings] = await Promise.all([
    ok(listTodo(supabase)),
    supabase.rpc("nav_counters", { p_today: today }),
    inboxCounts(supabase).catch(() => ({ unread: 0, awaiting: 0 })), // Messages lemlist : lu au CRM, aucun appel à lemlist ici
    ok(loadFinance(supabase, today)),
    ok(listProjects(supabase)),
    supabase.from("project_milestones").select("project_id, title, due_date").is("done_at", null).order("due_date").limit(500),
    supabase.from("project_tasks").select("project_id, title, due_date").neq("status", "termine").not("due_date", "is", null).order("due_date").limit(500),
    ok(listBookings(supabase, { from: zonedToUtc(day, "00:00", DEFAULT_TZ).toISOString(), to: zonedToUtc(addDaysKey(day, 1), "00:00", DEFAULT_TZ).toISOString() }, 50)),
  ]);
  const c = (counters.data ?? {}) as { replies?: number; calls?: number; emails?: number };
  // parcours des clients (diagnostic, proposition, signature, onboarding) : ce qui attend une action de ma part
  const journey = await ok(listJourney(supabase));

  // --- Finance du mois ---
  const from = monthStart(today), to = monthEnd(today);
  const fin = finance.ok ? (() => {
    const k = homeKpis(finance.v, from, to);
    const late = openInvoicesAt(finance.v, today).rows.filter((r) => r.late).sort((a, b) => (a.invoice.due_date ?? "").localeCompare(b.invoice.due_date ?? ""));
    return { received: k.received, invoiced: invoicedIn(finance.v.invoices, from, to).ht, pending: k.outstanding, lateTotal: k.late, late };
  })() : null;

  // --- Clients en cours : prochaine échéance (jalon, tâche datée ou rendez-vous), sinon la phase en cours ---
  const nextBy = new Map<string, Next>();
  const consider = (pid: string, n: Next) => { const cur = nextBy.get(pid); if (!cur || n.date < cur.date) nextBy.set(pid, n); };
  ((milestones.data ?? []) as { project_id: string; title: string; due_date: string }[]).forEach((m) => consider(m.project_id, { label: m.title, date: m.due_date }));
  ((ptasks.data ?? []) as { project_id: string; title: string; due_date: string }[]).forEach((t) => consider(t.project_id, { label: t.title, date: t.due_date }));
  const active = projects.ok ? projects.v.filter((p) => ACTIVE.has(p.status)) : [];
  active.forEach((p) => p.next_meeting_at && consider(p.id, { label: "Point client", date: p.next_meeting_at.slice(0, 10) }));
  active.sort((a, b) => (nextBy.get(a.id)?.date ?? "9999").localeCompare(nextBy.get(b.id)?.date ?? "9999"));

  // --- À traiter ---
  const items = todo.ok ? todo.v : [];
  const followups = items.filter((i) => i.item_type === "followup" && i.due_date <= today);
  const myTasks = items.filter((i) => i.item_type !== "followup" && i.due_date != null && i.due_date <= today);
  const todays = bookings.ok ? bookings.v.filter((b) => b.status === "confirmed") : [];
  const alerts = [
    (c.replies ?? 0) > 0 && { href: "/prospection/reponses", text: `${c.replies} réponse(s) de prospection à traiter`, key: "replies" },
    lemlist.unread > 0 && { href: "/messages", text: `${lemlist.unread} nouvelle(s) réponse(s) lemlist sur les comptes clients`, key: "messages" },
    (c.emails ?? 0) > 0 && { href: "/mail/a-rattacher", text: `${c.emails} email(s) reçu(s) à rattacher à une fiche`, key: "emails" },
  ].filter(Boolean) as { href: string; text: string; key: string }[];
  const nothing = !followups.length && !myTasks.length && !todays.length && !alerts.length && !(c.calls ?? 0);

  const FollowRow = ({ i }: { i: TodoItem }) => (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate"><strong>{i.company_name}</strong>{i.person_name && <span className="text-muted"> · {i.person_name}</span>}<span className="text-muted"> — {i.title}</span></span>
      <span className={i.due_date < today ? "shrink-0 text-xs font-bold text-danger" : "shrink-0 text-xs text-muted"}>{relativeDay(i.due_date)}</span>
      <Link href={`/prospection/focus?depart=${i.id}`} className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-violet-strong hover:bg-violet-soft">Traiter</Link>
    </li>
  );

  return (
    <div className="max-w-6xl" data-home>
      <PageHeader title="Accueil" description={formatDate(today)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Finance du mois" href="/finance" data-home-finance>
          {!fin ? <Empty>Chiffres indisponibles pour le moment. Réessayez dans un instant.</Empty> : (
            <>
              <dl className="grid grid-cols-3 gap-2">
                {([["Encaissé", fin.received, `/finance/revenus?vue=paiements&du=${from}&au=${to}`], ["Facturé", fin.invoiced, `/finance/revenus?vue=factures&du=${from}&au=${to}`], ["En attente", fin.pending, "/finance/revenus?vue=factures&statut=ouvertes"]] as const).map(([l, v, href]) => (
                  <Link key={l} href={href} className="min-w-0 rounded-xl border border-line p-2 hover:border-violet sm:p-2.5" data-kpi={l}>
                    <dt className="font-label text-xs font-semibold text-muted">{l}</dt>
                    <dd className="truncate font-display text-sm font-extrabold text-ink tabular-nums sm:text-lg">{eur(v, { round: true })}</dd>
                  </Link>
                ))}
              </dl>
              <h3 className="mt-4 mb-1.5 font-label text-xs font-bold text-muted uppercase">
                {fin.late.length ? <span className="inline-flex items-center gap-1 text-danger"><AlertTriangle size={12} aria-hidden /> Factures en retard · {fin.late.length} · {eur(fin.lateTotal)}</span> : "Factures en retard"}
              </h3>
              {fin.late.length ? (
                <ul className="divide-y divide-line rounded-xl border border-line" data-home-late>
                  {fin.late.slice(0, 5).map(({ invoice: i, balance }) => (
                    <li key={i.id}>
                      <Link href={`/finance/revenus?facture=${i.id}`} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-violet-soft/30">
                        <span className="min-w-0 flex-1 truncate"><strong>{i.company_name}</strong><span className="text-muted"> · {i.reference ?? "Sans numéro"}</span></span>
                        <span className="hidden shrink-0 text-xs font-bold text-danger sm:inline">échue {relativeDay(i.due_date)}</span>
                        <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{eur(balance)}</span>
                      </Link>
                    </li>
                  ))}
                  {fin.late.length > 5 && <li><Link href="/finance/revenus?vue=factures&statut=ouvertes" className="block px-3 py-2 text-xs font-semibold text-violet-strong">Voir les {fin.late.length} factures →</Link></li>}
                </ul>
              ) : <Empty>Aucune facture en retard.</Empty>}
            </>
          )}
        </Block>

        <Block title="Prochaines actions clients" href="/pipelines" data-home-journey-block>
          {!journey.ok ? <Empty>Parcours indisponible pour le moment.</Empty> : <JourneyActions lines={journeyTodos(journey.v)} />}
        </Block>

        <Block title="Clients en cours" href="/projets" data-home-clients>
          {!projects.ok ? <Empty>Projets indisponibles pour le moment.</Empty> : !active.length ? <Empty>Aucun projet client en cours.</Empty> : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {active.slice(0, 8).map((p) => {
                const n = nextBy.get(p.id);
                return (
                  <li key={p.id}>
                    <Link href={`/projets/${p.id}`} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-violet-soft/30" data-home-project>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate"><strong>{p.company_name}</strong><span className="text-muted"> · {p.name}</span></span>
                        <span className="block truncate text-xs text-muted">
                          {n ? <>Prochaine échéance : {n.label} · <span className={n.date < today ? "font-semibold text-danger" : ""}>{relativeDay(n.date)}</span></> : p.current_phase_name ? `Phase en cours : ${p.current_phase_name}` : "Aucune échéance prévue"}
                        </span>
                      </span>
                      {p.status !== "en_cours" && <Badge tone={p.status === "en_attente" ? "warning" : "neutral"}>{PROJECT_STATUS_LABELS[p.status]}</Badge>}
                      {(p.blocked_tasks ?? 0) > 0 && <Badge tone="danger">{p.blocked_tasks} bloquée(s)</Badge>}
                    </Link>
                  </li>
                );
              })}
              {active.length > 8 && <li><Link href="/projets" className="block px-3 py-2 text-xs font-semibold text-violet-strong">Voir les {active.length} projets →</Link></li>}
            </ul>
          )}
        </Block>

        <Block title="À traiter" data-home-todo>
          <div className="space-y-4">
            {nothing && <Empty>Rien à traiter pour aujourd&apos;hui.</Empty>}
            {!todo.ok && <p className="text-sm text-danger">Relances et tâches indisponibles pour le moment.</p>}
            {alerts.length > 0 && (
              <ul className="space-y-1.5">
                {alerts.map((a) => (
                  <li key={a.key}><Link href={a.href} data-home-alert={a.key} className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm hover:border-amber-300"><strong>{a.text}</strong><span className="shrink-0 pl-2 text-xs font-semibold">Ouvrir →</span></Link></li>
                ))}
              </ul>
            )}
            <HomeCalls initial={c.calls ?? 0} />
            {todays.length > 0 && (
              <section data-home-rdv>
                <h3 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">Rendez-vous du jour · {todays.length}</h3>
                <ul className="divide-y divide-line rounded-xl border border-line">{todays.map((b) => <BookingRow key={b.id} b={b} showDate={false} />)}</ul>
              </section>
            )}
            {followups.length > 0 && (
              <section data-home-followups>
                <h3 className="mb-1.5 flex items-baseline justify-between font-label text-xs font-bold text-muted uppercase">
                  <span>Relances de prospection · {followups.length}</span>
                  <Link href="/prospection/focus" className="inline-flex items-center gap-1 normal-case text-violet-strong hover:underline"><Zap size={12} aria-hidden /> Mode Focus</Link>
                </h3>
                <ul className="divide-y divide-line rounded-xl border border-line">{followups.slice(0, 8).map((i) => <FollowRow key={i.id} i={i} />)}</ul>
                {followups.length > 8 && <Link href="/prospection/focus" className="mt-1 block text-xs font-semibold text-violet-strong">Les {followups.length} relances en mode Focus →</Link>}
              </section>
            )}
            {myTasks.length > 0 && (
              <section data-home-tasks>
                <h3 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">Mes tâches de projet · {myTasks.length}</h3>
                <TasksList tasks={myTasks} />
              </section>
            )}
          </div>
        </Block>
      </div>
      <BookingDetailHost />
    </div>
  );
}
