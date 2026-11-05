import { AppShell } from "@/components/app-shell";
import { requireAppOwner } from "@/lib/auth";
import { listPipelines } from "@/lib/crm/service";
import type { LeadSource, List } from "@/lib/crm/types";

// Mise en page conservée entre les navigations : seules les données de référence, légères, sont
// lues ici. Les compteurs de la barre latérale arrivent à part et ne bloquent aucun affichage.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase } = await requireAppOwner();
  const [sources, lists, pipelines] = await Promise.all([
    supabase.from("lead_sources").select("id, name, position, color, archived_at").order("position").order("name"),
    supabase.from("lists").select("id, name, description, created_at").order("name"),
    listPipelines(supabase),
  ]);
  return (
    <AppShell sources={(sources.data ?? []) as LeadSource[]} lists={(lists.data ?? []) as List[]} pipelines={pipelines}>
      {children}
    </AppShell>
  );
}
