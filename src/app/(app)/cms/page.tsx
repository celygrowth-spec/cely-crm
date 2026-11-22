// CMS › Articles : liste filtrable par statut, création, import et export.
import { requireAppOwner } from "@/lib/auth";
import { cmsMissingTables } from "@/lib/cms/ready";
import { CmsNotInstalled } from "@/components/cms/not-installed";
import { listEntries, promoteDue } from "@/lib/cms/service";
import { Download, FileText } from "lucide-react";
import { ImportButton } from "@/components/cms/import-dialog";
import { ArticlesView } from "./articles-view";

export const dynamic = "force-dynamic";

export default async function CmsPage() {
  const { supabase } = await requireAppOwner();
  if (await cmsMissingTables(supabase)) return <CmsNotInstalled />;
  await promoteDue(supabase).catch(() => 0); // Programmé dont la date est passée → Publié (le site le voit déjà)
  const entries = await listEntries(supabase);
  const toolbar = (
    <>
      <a href="/modeles/modele-article-cms.md" download="modele-article-cms.md" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 text-sm font-semibold hover:border-violet" data-download-model>
        <FileText size={15} /> Télécharger le modèle
      </a>
      <ImportButton />
      {entries.length > 0 && (
        <a href="/api/cms/export" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 text-sm font-semibold hover:border-violet" data-export-all>
          <Download size={15} /> Exporter tout (.zip)
        </a>
      )}
    </>
  );
  return <ArticlesView entries={entries} toolbar={toolbar} />;
}
