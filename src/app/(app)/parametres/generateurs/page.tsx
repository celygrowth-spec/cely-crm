// Paramètres › Générateurs : la sélection de la bibliothèque (modèles, exemples, grille tarifaire, conditions,
// prompt) que chaque générateur reprend par défaut. Elle reste ajustable dossier par dossier, au moment de générer.
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireAppOwner } from "@/lib/auth";
import { listLibrary } from "@/lib/crm/library";
import { pathLabel } from "@/lib/crm/library-rules";
import { getDefaultLibrary } from "@/lib/generators/service";
import { DefaultLibrary } from "./default-library";

export const dynamic = "force-dynamic";

export default async function GenerateursPage() {
  const { supabase } = await requireAppOwner();
  const [lib, defaults] = await Promise.all([listLibrary(supabase), getDefaultLibrary(supabase)]);
  const items = lib.items
    .map((i) => ({ id: i.id, name: i.display_name, kind: i.kind, folder: pathLabel(lib.folders, i.folder_id) }))
    .sort((a, b) => a.folder.localeCompare(b.folder, "fr") || a.name.localeCompare(b.name, "fr"));
  const selected = (kind: string) => defaults.find((d) => d.kind === kind)?.library_item_ids ?? [];
  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/parametres" className="text-sm font-semibold text-muted hover:text-ink">← Paramètres</Link>
      <PageHeader title="Générateurs" description="Ce que la proposition et l'onboarding lisent par défaut dans votre bibliothèque. Réglé une fois ici, ajustable au moment de générer." />
      <DefaultLibrary kind="proposal" title="Proposition" items={items} initial={selected("proposal")} />
      <DefaultLibrary kind="onboarding" title="Onboarding" items={items} initial={selected("onboarding")} />
      <p className="text-xs text-muted">Les documents et les prompts s&apos;ajoutent dans <Link className="font-semibold text-violet-strong" href="/bibliotheque">Bibliothèque</Link>. Les questions de chaque générateur se modifient dans <code>src/content/generators</code>.</p>
    </div>
  );
}
