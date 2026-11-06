import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { PortalLogin } from "@/components/portal/login-form";
import { UpcomingMeetings, type UpcomingMeeting } from "@/components/portal/overview";
import { PortalTopBar } from "@/components/portal/shell";
import { PortalSessionError, portalRpc, portalSessionHash } from "@/lib/projects/portal";
import { PROJECT_STATUS_LABELS, type PortalMe } from "@/lib/projects/types";

export default async function PortalHome() {
  if (!(await portalSessionHash())) return <PortalLogin />;
  let me: PortalMe;
  try {
    me = await portalRpc<PortalMe>("portal_me");
  } catch (e) {
    if (e instanceof PortalSessionError) return <PortalLogin expired />;
    throw e;
  }
  if (me.projects.length === 1) redirect(`/portail/p/${me.projects[0].id}`);
  // points à venir de tous les projets partagés (les annulés n'y figurent pas, les reports sont lus en direct)
  const upcoming = me.projects.length ? await portalRpc<UpcomingMeeting[]>("portal_upcoming_meetings", { p_limit: 3 }).catch(() => null) : [];
  return (
    <>
      <PortalTopBar me={me} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="font-display text-2xl font-bold text-ink">Bonjour {me.person.first_name ?? ""}</h1>
        <p className="mt-1 text-sm text-muted">Vos projets avec Cely Growth.</p>
        {me.projects.length > 0 && (
          <div className="mt-6">
            {upcoming ? <UpcomingMeetings meetings={upcoming} showProject hrefFor={(m) => `/portail/p/${m.project_id}/points/${m.id}`} />
              : <p className="rounded-xl border border-line bg-white p-4 text-sm text-muted">Les prochains points n&apos;ont pas pu être chargés. Ouvrez un projet pour les consulter.</p>}
          </div>
        )}
        {me.projects.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-line bg-white p-6 text-sm text-muted">Aucun projet n&apos;est partagé avec vous pour le moment.</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {me.projects.map((p) => (
              <li key={p.id}>
                <Link href={`/portail/p/${p.id}`} className="row-in flex items-center gap-3 rounded-xl border border-line bg-white p-4 hover:border-violet">
                  <span className="flex-1">
                    <span className="block font-display text-lg font-bold text-ink">{p.name}</span>
                    <span className="text-sm text-muted">{PROJECT_STATUS_LABELS[p.status]}{p.read_only ? " · consultation seule" : ""}</span>
                  </span>
                  <ArrowRight size={18} className="text-violet-strong" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
