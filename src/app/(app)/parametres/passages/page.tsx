import { PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { RunNow } from "./run-now";

// Passages planifiés (C07) : ce qui tourne sans vous, sa dernière réussite et sa dernière erreur.
const JOBS = [
  { job: "agenda", label: "Agenda Google", what: "Répercute annulations, reports et modifications ; signale les déplacements faits dans Google." },
  { job: "rappels", label: "Rappels de rendez-vous", what: "Envoie par Gmail les rappels dus (version du rendez-vous vérifiée juste avant)." },
  { job: "gmail", label: "Réception Gmail", what: "Rattache les réponses de vos contacts ; met les relances en pause." },
  { job: "fireflies", label: "Fireflies", what: "Rattrape les appels manqués par le webhook." },
] as const;

type Row = { job: string; last_started_at: string | null; last_success_at: string | null; last_error: string | null; last_error_at: string | null; last_result: Record<string, unknown> | null };

export default async function PassagesPage() {
  const { supabase } = await requireOwner();
  const [{ data }, { data: sync }] = await Promise.all([
    supabase.from("scheduled_jobs").select("*"),
    supabase.from("mail_sync_state").select("last_sync_at, last_error, initial_done_at, imported").limit(1).maybeSingle(),
  ]);
  const rows = new Map(((data ?? []) as Row[]).map((r) => [r.job, r]));
  return (
    <div className="max-w-4xl">
      <PageHeader title="Passages planifiés" description="Tâches lancées automatiquement (une fois par jour sur l'offre Vercel actuelle ; toutes les 15 minutes avec le planificateur Supabase, voir docs/planificateur.md)." actions={<RunNow />} />
      <ul className="space-y-2" data-jobs>
        {JOBS.map((j) => {
          const r = rows.get(j.job);
          const failing = r?.last_error && (!r.last_success_at || (r.last_error_at ?? "") > r.last_success_at);
          const skipped = r?.last_result && typeof r.last_result.skipped === "string" ? (r.last_result.skipped as string) : null;
          return (
            <li key={j.job} className="rounded-xl border border-line p-3" data-job={j.job}>
              <p className="font-semibold">{j.label} <span className={`ml-1 text-xs ${failing ? "text-danger" : skipped ? "text-warning" : "text-muted"}`}>
                {!r ? "jamais lancé" : failing ? "en échec" : skipped ? "non actif" : "OK"}</span></p>
              <p className="text-xs text-muted">{j.what}</p>
              <p className="mt-1 text-xs">Dernière réussite : {r?.last_success_at ? formatDateTime(r.last_success_at) : "—"}
                {r?.last_error && <> · Dernière erreur ({r.last_error_at ? formatDateTime(r.last_error_at) : ""}) : <span className="text-danger">{r.last_error}</span></>}</p>
              {skipped && <p className="text-xs text-warning">{skipped}</p>}
            </li>
          );
        })}
      </ul>
      {sync && <p className="mt-3 text-xs text-muted">Gmail : {sync.imported} email(s) reçu(s) rattaché(s) · dernière lecture {sync.last_sync_at ? formatDateTime(sync.last_sync_at) : "—"}{sync.last_error ? ` · ${sync.last_error}` : ""}</p>}
    </div>
  );
}
