import { PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { LibraryView } from "./library-view";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await requireOwner();
  const dossier = (await searchParams).dossier;
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Bibliothèque" description="Vos prompts et documents, rangés par dossiers. Privée : visible de vous seul et de Claude (en lecture) avec votre autorisation, jamais du portail client." />
      <LibraryView initialFolder={typeof dossier === "string" ? dossier : null} />
    </div>
  );
}
