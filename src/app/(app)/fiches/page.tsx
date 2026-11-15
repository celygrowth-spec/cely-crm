import { requireOwner } from "@/lib/auth";
import { ProspectTable } from "../prospection/base/prospect-table";

// Commerce › Fiches : toutes les fiches (entreprises et leurs personnes), avec « Nouvelle fiche ». Même tableau que
// Prospection › Base de prospects (mêmes filtres, même cache).
export default async function FichesPage() {
  const { supabase } = await requireOwner();
  const { data: campaigns } = await supabase.from("campaigns").select("id, name").is("archived_at", null).order("created_at", { ascending: false });
  return <ProspectTable campaigns={campaigns ?? []} title="Fiches" />;
}
