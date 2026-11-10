import { requireOwner } from "@/lib/auth";
import { DEFAULT_PERIOD, isPeriod } from "@/lib/sales/rules";
import { listSales } from "@/lib/sales/service";
import { SalesView, type SalesTab } from "./sales-view";

export default async function VentesPage({ searchParams }: { searchParams: Promise<{ vue?: string; periode?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const rows = await listSales(supabase);
  const tab: SalesTab = sp.vue === "gagnees" || sp.vue === "perdues" ? sp.vue : "suivi";
  return <SalesView initial={rows} tab={tab} period={isPeriod(sp.periode) ? sp.periode : DEFAULT_PERIOD} />;
}
