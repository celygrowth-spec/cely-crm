import { AppShell } from "@/components/app-shell";
import { requireOwner } from "@/lib/auth";
import { listPipelines } from "@/lib/crm/service";
import type { LeadSource, List } from "@/lib/crm/types";
import { todayISO } from "@/lib/format";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase } = await requireOwner();
  const [sources, lists, pipelines, todo, due, replies] = await Promise.all([
    supabase.from("lead_sources").select("id, name, position").order("position").order("name"),
    supabase.from("lists").select("id, name, description, created_at").order("name"),
    listPipelines(supabase),
    supabase.from("todo_items").select("id", { count: "exact", head: true }).lte("due_date", todayISO()),
    supabase.from("todo_items").select("id", { count: "exact", head: true }).eq("item_type", "followup").lte("due_date", todayISO()),
    supabase.from("campaign_participants").select("id", { count: "exact", head: true }).eq("status", "a_repondu").in("outcome", ["none", "replied"]),
  ]);
  return (
    <AppShell
      sources={(sources.data ?? []) as LeadSource[]}
      lists={(lists.data ?? []) as List[]}
      pipelines={pipelines}
      todoCount={todo.count ?? 0}
      dueCount={due.count ?? 0}
      repliesCount={replies.count ?? 0}
    >
      {children}
    </AppShell>
  );
}
