import { requireOwner } from "@/lib/auth";
import { ProspectTable } from "./prospect-table";

// Coquille immédiate : les lignes sont paginées côté serveur et mises en cache côté client.
export default async function ProspectionPage() {
  const { supabase } = await requireOwner();
  const { data: campaigns } = await supabase.from("campaigns").select("id, name").is("archived_at", null).order("created_at", { ascending: false });
  return <ProspectTable campaigns={campaigns ?? []} />;
}
