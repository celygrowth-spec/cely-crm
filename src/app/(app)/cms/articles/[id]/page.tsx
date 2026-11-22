// CMS › éditeur d'un article.
import { notFound } from "next/navigation";
import { requireAppOwner } from "@/lib/auth";
import { cmsMissingTables } from "@/lib/cms/ready";
import { CmsNotInstalled } from "@/components/cms/not-installed";
import { getEntry } from "@/lib/cms/service";
import { EntryEditor } from "./entry-editor";

export const dynamic = "force-dynamic";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { supabase } = await requireAppOwner();
  if (await cmsMissingTables(supabase)) return <CmsNotInstalled />;
  const entry = await getEntry(supabase, id);
  if (!entry) notFound();
  // clé stable : un rafraîchissement après enregistrement ne doit pas effacer une saisie en cours (date, champs)
  return <EntryEditor key={entry.id} entry={entry} />;
}
