import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { projectMembers } from "@/lib/projects/owner";
import type { PortalProjectView } from "@/lib/projects/types";
import { PortalOverview } from "@/components/portal/overview";
import { EmptyState } from "@/components/ui";

// Aperçu du portail tel qu'un contact le voit : contenu produit par la même fonction de visibilité que le
// vrai portail (portal_private.project_view). Ne remplace pas un test avec un véritable accès client.
export default async function PreviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ personne?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const members = await projectMembers(supabase, id);
  if (!members.length) return <EmptyState title="Aucun contact" description="Ajoutez un contact au projet pour prévisualiser son portail." />;
  const person = members.find((m) => m.person_id === sp.personne) ?? members[0];
  const { data, error } = await supabase.rpc("portal_preview_project", { p_project: id, p_person: person.person_id });
  if (error) throw new CrmError(friendlyError(error));
  // K11 : l'aperçu dit si ce contact voit réellement le projet (publication et accès valide)
  const [{ data: proj }, { data: access }] = await Promise.all([
    supabase.from("projects").select("portal_published, status").eq("id", id).maybeSingle(),
    supabase.from("portal_accesses").select("revoked_at, expires_at").eq("person_id", person.person_id).is("revoked_at", null).limit(1).maybeSingle(),
  ]);
  const published = !!(proj as { portal_published?: boolean } | null)?.portal_published;
  const a = access as { expires_at: string | null } | null;
  const validAccess = !!a && (!a.expires_at || Date.parse(a.expires_at) > Date.now());
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-violet-line bg-violet-soft/50 px-3 py-2 text-sm">
        <span className="font-semibold">Aperçu en tant que</span>
        {members.map((m) => (
          <Link key={m.person_id} href={`?personne=${m.person_id}`} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.person_id === person.person_id ? "bg-ink text-white" : "bg-white text-ink"}`}>
            {[m.first_name, m.last_name].filter(Boolean).join(" ") || m.email}
          </Link>
        ))}
        <span className="text-xs text-muted">Contenu publié uniquement, comme sur le portail.</span>
      </div>
      {(!published || !validAccess) && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm" role="status" data-preview-warning>
          <strong>Ce contact ne voit rien pour l&apos;instant :</strong>{" "}
          {[!published && "le projet n'est pas publié sur le portail", !validAccess && (a ? "son code d'accès a expiré" : "il n'a pas de code d'accès valide")].filter(Boolean).join(" ; ")}.
          {" "}<Link className="font-semibold text-violet-strong" href={`/projets/${id}/acces`}>Gérer les accès</Link>
        </p>
      )}
      <div className="rounded-2xl bg-surface p-4">
        <PortalOverview project={data as PortalProjectView} />
      </div>
    </div>
  );
}
