// Productivité › To do list : tâches simples, classées par urgence, reliées au plus à une fiche.
import { requireAppOwner } from "@/lib/auth";
import { TodoView } from "./todo-view";

export const dynamic = "force-dynamic";

export default async function TodoPage() {
  await requireAppOwner();
  return <TodoView />;
}
