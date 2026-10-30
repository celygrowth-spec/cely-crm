import { requireOwner } from "@/lib/auth";
import { listTodo } from "@/lib/crm/service";
import { TodoView } from "./todo-view";

export default async function AFairePage() {
  const { supabase } = await requireOwner();
  const items = await listTodo(supabase);
  return <TodoView items={items} />;
}
