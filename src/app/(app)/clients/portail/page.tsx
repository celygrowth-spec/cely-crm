import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { listProjects } from "@/lib/projects/owner";
import { PROJECT_STATUS_LABELS } from "@/lib/projects/types";

// Clients › Portail client : ce que chaque client voit réellement (projet publié, accès valides), avec un accès direct
// à la gestion des accès et à l'aperçu. Lecture seule : tout se règle dans le projet.
export const dynamic = "force-dynamic";

export default async function PortailClientPage() {
  const { supabase } = await requireOwner();
  const projects = await listProjects(supabase);
  const ids = projects.map((p) => p.id);
  const { data: members } = ids.length ? await supabase.from("project_members").select("project_id, person_id").in("project_id", ids) : { data: [] };
  const people = [...new Set((members ?? []).map((m) => m.person_id as string))];
  const { data: accesses } = people.length
    ? await supabase.from("portal_accesses").select("person_id, expires_at").in("person_id", people).is("revoked_at", null)
    : { data: [] };
  const now = new Date().toISOString();
  const valid = new Set((accesses ?? []).filter((a) => !a.expires_at || (a.expires_at as string) > now).map((a) => a.person_id as string));
  const rows = projects.map((p) => {
    const mine = (members ?? []).filter((m) => m.project_id === p.id).map((m) => m.person_id as string);
    return { p, members: mine.length, access: mine.filter((x) => valid.has(x)).length };
  });
  return (
    <div className="max-w-5xl">
      <PageHeader title="Portail client" description="Ce que chaque client voit : projet publié et accès valides. Les accès et la publication se règlent dans le projet." />
      {!rows.length ? (
        <EmptyState title="Aucun projet" description="Un projet apparaît ici dès sa création ; publiez-le et donnez un accès à un contact pour qu'il le voie." />
      ) : (
        <Card className="divide-y divide-line" data-portal-list>
          {rows.map(({ p, members: n, access }) => {
            const seen = p.portal_published && access > 0;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm" data-portal-project={p.id}>
                <div className="min-w-0 flex-1">
                  <Link href={`/projets/${p.id}`} className="font-semibold hover:text-violet-strong">{p.name}</Link>
                  <p className="text-xs text-muted">{p.company_name} · {PROJECT_STATUS_LABELS[p.status]}</p>
                </div>
                <Badge tone={p.portal_published ? "success" : "neutral"}>{p.portal_published ? "Publié" : "Non publié"}</Badge>
                <Badge tone={access ? "violet" : "warning"}>{access}/{n} accès valide(s)</Badge>
                {!seen && <span className="text-xs text-warning">Le client ne voit rien</span>}
                <Link href={`/projets/${p.id}/acces`} className="text-xs font-semibold text-violet-strong hover:underline">Accès</Link>
                <Link href={`/projets/${p.id}/apercu`} className="text-xs font-semibold text-violet-strong hover:underline">Aperçu</Link>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
