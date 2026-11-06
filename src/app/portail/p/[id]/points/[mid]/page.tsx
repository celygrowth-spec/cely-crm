import Link from "next/link";
import { notFound } from "next/navigation";
import { portalLoad } from "@/lib/projects/portal-load";
import { TASK_STATUS_LABELS, type PortalMeetingDetail, type PortalTask } from "@/lib/projects/types";
import { formatDate } from "@/lib/format";
import { MeetingDetail } from "@/components/portal/meeting-detail";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function MeetingPage({ params }: { params: Promise<{ id: string; mid: string }> }) {
  const { id, mid } = await params;
  if (!UUID_RE.test(mid)) notFound();
  const [m, tasks] = await Promise.all([
    portalLoad<PortalMeetingDetail>("portal_meeting", { p_project: id, p_meeting: mid }),
    portalLoad<PortalTask[]>("portal_tasks", { p_project: id, p_limit: 300 }),
  ]);
  const linked = tasks.filter((t) => t.meeting?.id === mid);
  return (
    <div className="space-y-4">
      <Link href={`/portail/p/${id}`} className="text-sm font-semibold text-muted hover:text-ink">← Vue d&apos;ensemble</Link>
      <MeetingDetail m={m} />
      <section aria-labelledby="taches-point" className="rounded-2xl border border-line bg-white p-5 sm:p-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="taches-point" className="font-display text-lg font-bold text-ink">Tâches liées à ce point</h2>
          {linked.length > 0 && <Link href={`/portail/p/${id}/taches?point=${mid}`} className="text-xs font-semibold text-violet-strong underline">Ouvrir dans les tâches</Link>}
        </div>
        {linked.length === 0 ? <p className="text-sm text-muted">Aucune tâche partagée n&apos;est liée à ce point.</p> : (
          <ul className="divide-y divide-line">
            {linked.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="flex-1 font-semibold text-ink">{t.title}</span>
                <span className="text-xs text-muted">{t.assignee.kind === "me" ? "Vous" : t.assignee.name}</span>
                {t.due_date && <span className="text-xs text-muted">avant le {formatDate(t.due_date)}</span>}
                <span className="rounded-full bg-surface px-2 py-0.5 font-label text-[11px] text-muted">{TASK_STATUS_LABELS[t.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
