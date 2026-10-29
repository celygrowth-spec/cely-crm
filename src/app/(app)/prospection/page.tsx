import { requireOwner } from "@/lib/auth";
import { fetchAll } from "@/lib/crm/service";
import type { CompanyOverview } from "@/lib/crm/types";
import { ProspectTable } from "./prospect-table";

export default async function ProspectionPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { supabase } = await requireOwner();
  const { archived } = await searchParams;
  const showArchived = archived === "1";
  const { data, error } = await fetchAll<CompanyOverview>((from, to) => {
    const q = supabase.from("company_overview").select("*").order("created_at", { ascending: false }).range(from, to);
    return showArchived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  });
  const { data: campaigns } = await supabase.from("campaigns").select("id, name").is("archived_at", null).order("created_at", { ascending: false });
  if (error) return <p className="text-danger">Impossible de charger les fiches : {error}</p>;
  return <ProspectTable rows={data} showArchived={showArchived} campaigns={campaigns ?? []} />;
}
