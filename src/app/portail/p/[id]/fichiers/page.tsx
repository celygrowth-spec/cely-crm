import { portalLoad } from "@/lib/projects/portal-load";
import type { LibFile, LibFolder } from "@/components/projects/file-library";
import { PortalFiles } from "@/components/portal/files";

export default async function PortalFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await portalLoad<{ folders: LibFolder[]; files: LibFile[]; total: number; read_only: boolean }>("portal_files", { p_project: id, p_limit: 300, p_offset: 0 });
  return (
    <div>
      <h1 className="mb-4 font-display text-2xl font-bold text-ink">Fichiers</h1>
      <PortalFiles projectId={id} folders={d.folders} files={d.files} readOnly={d.read_only} />
      {d.total > d.files.length && <p className="mt-2 text-xs text-muted">{d.files.length} fichiers affichés sur {d.total} : utilisez la recherche pour retrouver les plus anciens.</p>}
    </div>
  );
}
