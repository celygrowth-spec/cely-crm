import { requireOwner } from "@/lib/auth";
import { listTodo } from "@/lib/crm/service";
import type { Person } from "@/lib/crm/types";
import { TodoView } from "./todo-view";

export default async function AFairePage() {
  const { supabase } = await requireOwner();
  const items = await listTodo(supabase);
  const companyIds = [...new Set(items.filter((i) => i.item_type === "followup").map((i) => i.company_id))];
  const { data: people } = companyIds.length
    ? await supabase.from("people").select("*").in("company_id", companyIds)
    : { data: [] as Person[] };
  return <TodoView items={items} people={(people ?? []) as Person[]} />;
}
