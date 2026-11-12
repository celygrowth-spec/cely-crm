import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { getProject } from "@/lib/projects/owner";
import { Badge } from "@/components/ui";
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES } from "@/lib/projects/types";
import { ProjectSalePanel } from "@/components/sales/project-sale-panel";
import { ProjectTabs } from "./tabs";
import { TrashAndLeave } from "@/components/trash/trash-and-leave";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  return (
    <div>
      <div className="mb-4">
        <Link href="/projets" className="text-xs font-semibold text-muted hover:text-ink">← Projets</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{p.name}</h1>
          <Badge tone={PROJECT_STATUS_TONES[p.status]}>{PROJECT_STATUS_LABELS[p.status]}</Badge>
          {p.portal_published ? <Badge tone="success">Visible sur le portail</Badge> : <Badge>Non publié</Badge>}
          <span className="ml-auto"><TrashAndLeave kind="project" id={p.id} href="/projets" label="Supprimer le projet" /></span>
        </div>
        <p className="mt-1 text-sm text-muted">
          Client : <Link href={`/fiches/${p.company_id}`} className="font-semibold text-ink hover:underline">{p.company_name}</Link>
          <Link href={`/projets/${p.id}/apercu`} className="ml-3 inline-flex items-center gap-1 font-semibold text-violet-strong hover:underline">
            Prévisualiser le portail <ExternalLink size={12} />
          </Link>
        </p>
      </div>
      <ProjectSalePanel projectId={p.id} companyId={p.company_id} />
      <ProjectTabs id={p.id} />
      {children}
    </div>
  );
}
