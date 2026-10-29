import { requireOwner } from "@/lib/auth";
import { ListsManager } from "./lists-manager";

export default async function ListesPage() {
  const { supabase } = await requireOwner();
  const { data, error } = await supabase.from("lists").select("id, name, description, created_at, list_members(count)").order("name");
  if (error) return <p className="text-danger">{error.message}</p>;
  const lists = (data ?? []).map((l) => ({
    id: l.id as string,
    name: l.name as string,
    description: l.description as string | null,
    count: ((l.list_members as unknown as { count: number }[])[0]?.count ?? 0) as number,
  }));
  return <ListsManager lists={lists} />;
}
