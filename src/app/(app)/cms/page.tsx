// CMS › Articles : liste filtrable par statut, création, import et export.
import { requireAppOwner } from "@/lib/auth";
import { listEntries, promoteDue } from "@/lib/cms/service";
import { ArticlesView } from "./articles-view";

export const dynamic = "force-dynamic";

export default async function CmsPage() {
  const { supabase } = await requireAppOwner();
  await promoteDue(supabase).catch(() => 0); // Programmé dont la date est passée → Publié (le site le voit déjà)
  const entries = await listEntries(supabase);
  return <ArticlesView entries={entries} />;
}
