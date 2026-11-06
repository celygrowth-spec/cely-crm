import { PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { DiagnosticLibrary } from "./diagnostic-library";

export default async function DiagnosticLibraryPage() {
  await requireOwner();
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Bibliothèque de diagnostic" description="Le prompt et les fichiers que Claude lit au lancement de chaque diagnostic. Privés : seul Claude, avec votre autorisation, y a accès." />
      <DiagnosticLibrary />
    </div>
  );
}
