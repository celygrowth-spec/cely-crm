import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { getProject } from "@/lib/projects/owner";
import { AdminFiles } from "./admin-files";

export default async function ProjectFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  const [folders, shared, all] = await Promise.all([
    supabase.from("project_folders").select("id, name, parent_id").eq("project_id", id).order("name"),
    supabase.from("project_file_overview").select("*").eq("project_id", id).order("shared_at", { ascending: false }).limit(500),
    supabase.from("company_files").select("id, display_name, created_at").eq("company_id", p.company_id).eq("status", "ready").order("created_at", { ascending: false }).limit(200),
  ]);
  for (const r of [folders, shared, all]) if (r.error) throw new CrmError(friendlyError(r.error));
  const rows = (shared.data ?? []) as { id: string; file_id: string; display_name: string; mime_type: string; size_bytes: number; folder_id: string | null; shared_at: string; author: string; uploaded_by_kind: string }[];
  const sharedIds = new Set(rows.map((r) => r.file_id));
  return (
    <AdminFiles
      projectId={id}
      companyId={p.company_id}
      folders={(folders.data ?? []) as { id: string; name: string; parent_id: string | null }[]}
      files={rows.map((r) => ({ id: r.id, name: r.display_name, mime_type: r.mime_type, size: r.size_bytes, folder_id: r.folder_id, created_at: r.shared_at, author: r.author }))}
      internal={((all.data ?? []) as { id: string; display_name: string; created_at: string }[]).filter((f) => !sharedIds.has(f.id))}
    />
  );
}
