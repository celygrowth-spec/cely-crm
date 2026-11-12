// Corbeille : éléments supprimés, restaurables pendant 30 jours, puis purgés automatiquement.
import { PageHeader } from "@/components/ui";
import { requireAppOwner } from "@/lib/auth";
import { listTrash } from "@/lib/trash/service";
import { TrashView } from "./trash-view";

export const dynamic = "force-dynamic";

export default async function CorbeillePage() {
  const { supabase } = await requireAppOwner();
  const [items, queue] = await Promise.all([
    listTrash(supabase),
    supabase.from("trash_file_queue").select("path", { count: "exact", head: true }),
  ]);
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Corbeille"
        description="Les éléments supprimés restent ici 30 jours : ils sont invisibles partout ailleurs (listes, recherche, Finance, portail client, Claude). Après 30 jours, ils sont supprimés définitivement avec leurs fichiers."
      />
      <TrashView items={items} filesPending={queue.count ?? 0} />
    </div>
  );
}
