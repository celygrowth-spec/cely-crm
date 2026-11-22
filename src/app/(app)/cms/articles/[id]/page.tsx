// CMS › éditeur d'un article.
import { notFound } from "next/navigation";
import { requireAppOwner } from "@/lib/auth";
import { getEntry } from "@/lib/cms/service";
import { EntryEditor } from "./entry-editor";

export const dynamic = "force-dynamic";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { supabase } = await requireAppOwner();
  const entry = await getEntry(supabase, id);
  if (!entry) notFound();
  return <EntryEditor key={entry.updated_at} entry={entry} />;
}
