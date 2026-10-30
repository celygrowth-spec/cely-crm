import { requireOwner } from "@/lib/auth";
import { financeData } from "../load";
import { ClientsView, type CompanyInfo } from "./clients-view";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ tous?: string; type?: string }> }) {
  const { supabase } = await requireOwner();
  const data = await financeData();
  const sp = await searchParams;
  const ids = [...new Set([...data.missions.map((m) => m.company_id), ...data.invoices.map((i) => i.company_id)])];
  const { data: info } = ids.length
    ? await supabase
        .from("company_overview")
        .select("id, name, website, deal_status, amount, stage_id, last_interaction_at, primary_person_name, primary_person_email, next_action_title, next_action_due")
        .in("id", ids)
    : { data: [] };
  const { data: stages } = await supabase.from("stages").select("id, name, pipeline:pipelines(name)");
  const stageName = new Map((stages ?? []).map((s) => [s.id, `${(s.pipeline as unknown as { name: string })?.name ?? ""} › ${s.name}`]));
  const companies: CompanyInfo[] = (info ?? []).map((c) => ({ ...c, stage: c.stage_id ? stageName.get(c.stage_id) ?? null : null })) as CompanyInfo[];
  return <ClientsView data={data} companies={companies} showAll={sp.tous === "1"} recurringOnly={sp.type === "recurrent"} />;
}
