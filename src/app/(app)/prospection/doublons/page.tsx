import { requireOwner } from "@/lib/auth";
import { DuplicatesList, type Pair } from "./duplicates-list";

export default async function DoublonsPage() {
  const { supabase } = await requireOwner();
  const { data, error } = await supabase.rpc("list_duplicate_pairs");
  if (error) return <p className="text-danger">{error.message}</p>;
  return <DuplicatesList pairs={(data ?? []) as Pair[]} />;
}
