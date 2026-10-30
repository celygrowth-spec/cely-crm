import Link from "next/link";
import { notFound } from "next/navigation";
import { Zap } from "lucide-react";
import { Stat, StepIcon } from "@/components/prospection/bits";
import { requireOwner } from "@/lib/auth";
import { pct, personName, relativeDay, todayISO } from "@/lib/format";
import { getCampaignWorkspace } from "@/lib/prospection/service";
import { STEP_META } from "@/lib/prospection/steps";
import { stepsOf, targetPerson } from "@/lib/prospection/workspace";

// Vue d'ensemble : chiffres issus uniquement des événements enregistrés.
export default async function CampaignOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const ws = await getCampaignWorkspace(supabase, id);
  if (!ws) notFound();
  const c = ws.campaign;
  const today = todayISO();
  const base = `/prospection/campagnes/${id}`;
  const activated = ws.participants.filter((p) => p.status !== "a_preparer").length;
  // taux : parmi les entreprises contactées (au moins une étape réalisée), comptées une fois
  const contactedRows = ws.participants.filter((p) => p.last_done_at);
  const repliedOfContacted = contactedRows.filter((p) => p.outcome !== "none" || p.status === "a_repondu").length;
  const interestedOfContacted = contactedRows.filter((p) => p.outcome === "interested" || p.outcome === "meeting").length;
  const meetingsOfContacted = contactedRows.filter((p) => p.outcome === "meeting").length;
  const done = ws.participants.filter((p) => p.status === "termine" || p.status === "arrete").length;
  const steps = stepsOf(ws, c.current_version);
  const active = ws.participants.filter((p) => p.status === "a_contacter" || p.status === "en_cours");
  const byStep = steps.map((s) => ({ s, n: active.filter((p) => p.sequence_version === c.current_version && p.current_step === s.position).length }));
  const otherVersions = active.filter((p) => p.sequence_version !== c.current_version).length;
  const maxStep = Math.max(1, ...byStep.map((x) => x.n));
  const next = active
    .filter((p) => p.next_due_date)
    .sort((a, b) => (a.next_due_date! < b.next_due_date! ? -1 : 1))
    .slice(0, 8);

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Inscrites" value={c.enrolled} hint={`${c.to_prepare} à préparer`} href={`${base}/prospects`} />
        <Stat label="Contactées" value={c.contacted} hint={`${pct(c.contacted, activated)} des activées`} href={`${base}/prospects?vue=en_cours`} />
        <Stat label="Réponses" value={c.replied} hint={`taux ${pct(repliedOfContacted, contactedRows.length)} des contactées`} href={`${base}/prospects?vue=repondu`} />
        <Stat label="Intéressées" value={c.interested} hint={`${pct(interestedOfContacted, contactedRows.length)} des contactées`} href={`${base}/prospects?vue=interesse`} tone="success" />
        <Stat label="Rendez-vous" value={c.meetings} hint={`${pct(meetingsOfContacted, contactedRows.length)} des contactées`} href={`${base}/prospects?vue=interesse`} />
        <Stat label="En pipeline" value={c.moved_to_pipeline} hint="fiches passées en pipeline" />
        <Stat label="Aujourd'hui" value={c.due_today} hint="actions dues" href={`${base}/prospects?vue=a_relancer`} />
        <Stat label="En retard" value={c.overdue} hint="actions dépassées" href={`${base}/prospects?vue=retard`} tone={c.overdue ? "danger" : undefined} />
      </section>
      <p className="-mt-3 text-[11px] text-muted">
        Une entreprise compte une seule fois par campagne. « Contactée » : au moins une étape réalisée dans la campagne. Taux de réponse = entreprises contactées ayant
        répondu ÷ entreprises contactées (une réponse sans prise de contact préalable est comptée dans « Réponses » mais pas dans le taux). « — » quand le dénominateur est nul. Aucun suivi d&apos;ouverture ni de clic.
      </p>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-xl border border-line p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-base font-bold">Que faire maintenant</h2>
            {c.status === "active" && c.due_today + c.overdue > 0 && (
              <Link href={`/prospection/focus?campagne=${id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-semibold text-white hover:bg-violet-strong">
                <Zap size={14} /> Commencer la session ({c.due_today + c.overdue})
              </Link>
            )}
          </div>
          {c.status === "paused" && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm">Campagne en pause : ses actions ne sont pas proposées dans « Aujourd&apos;hui ».</p>}
          {c.to_prepare > 0 && (
            <Link href={`${base}/preparation`} className="mb-2 block rounded-lg border border-violet-line bg-violet-soft px-3 py-2 text-sm hover:border-violet">
              <strong>{c.to_prepare} prospect(s) à préparer</strong> : vérifiez les personnes ciblées et les variables, puis activez-les.
            </Link>
          )}
          {next.length ? (
            <ul className="divide-y divide-line">
              {next.map((p) => {
                const st = stepsOf(ws, p.sequence_version).find((s) => s.position === p.current_step);
                const person = targetPerson(p, ws.people);
                return (
                  <li key={p.id} className="flex items-center gap-2 py-1.5 text-sm">
                    {st && <StepIcon type={st.step_type} size={11} />}
                    <span className="min-w-0 flex-1 truncate"><strong>{p.company.name}</strong>{person && <span className="text-muted"> · {personName(person)}</span>} — {st?.name}</span>
                    <span className={p.next_due_date! < today ? "text-xs font-bold text-danger" : "text-xs text-muted"}>{relativeDay(p.next_due_date)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">Aucune action planifiée.</p>
          )}
        </section>

        <section className="rounded-xl border border-line p-4">
          <h2 className="mb-1 font-display text-base font-bold">Progression</h2>
          <div className="mb-3">
            <div className="flex justify-between text-xs text-muted"><span>{done} terminée(s) ou arrêtée(s) sur {activated} activée(s)</span><span>{pct(done, activated)}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-violet" style={{ width: activated ? `${(done / activated) * 100}%` : 0 }} /></div>
          </div>
          <h3 className="mb-1 font-label text-xs font-bold text-muted uppercase">Répartition par étape (en cours)</h3>
          <ul className="space-y-1">
            {byStep.map(({ s, n }) => (
              <li key={s.position} className="grid grid-cols-[1.5rem_1fr_2rem] items-center gap-2 text-sm">
                <StepIcon type={s.step_type} size={11} />
                <div>
                  <p className="truncate text-xs">{s.position}. {s.name} <span className="text-muted">· {STEP_META[s.step_type].label}</span></p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-violet-strong" style={{ width: `${(n / maxStep) * 100}%` }} /></div>
                </div>
                <span className="text-right font-label text-xs tabular-nums">{n}</span>
              </li>
            ))}
            {!steps.length && <li className="text-sm text-muted">Séquence vide. <Link className="text-violet-strong" href={`${base}/sequence`}>Construire la séquence →</Link></li>}
          </ul>
          {otherVersions > 0 && <p className="mt-2 text-xs text-muted">+ {otherVersions} participant(s) sur une version précédente de la séquence.</p>}
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md bg-surface py-1.5"><p className="font-bold">{c.finished}</p><p className="text-muted">Séquence finie</p></div>
            <div className="rounded-md bg-surface py-1.5"><p className="font-bold">{c.not_interested}</p><p className="text-muted">Pas intéressées</p></div>
            <div className="rounded-md bg-surface py-1.5"><p className="font-bold">{c.stopped}</p><p className="text-muted">Arrêtées</p></div>
          </div>
        </section>
      </div>
    </div>
  );
}
