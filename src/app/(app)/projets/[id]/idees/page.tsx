import { requireOwner } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { Idea } from "@/lib/projects/types";
import { AdminIdeas } from "./admin-ideas";

export default async function IdeasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const ideas = await supabase.from("project_ideas").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(300);
  if (ideas.error) throw new CrmError(friendlyError(ideas.error));
  const ideaIds = (ideas.data ?? []).map((i) => i.id as string);
  const [comments, tasks] = await Promise.all([
    ideaIds.length ? supabase.from("project_idea_comments").select("id, idea_id, body, created_at, author_kind, person_id").in("idea_id", ideaIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    supabase.from("project_tasks").select("id, idea_id").eq("project_id", id).not("idea_id", "is", null),
  ]);
  for (const r of [comments, tasks]) if (r.error) throw new CrmError(friendlyError(r.error));
  const personIds = [...new Set([...(ideas.data ?? []).map((i) => i.author_person as string | null), ...((comments.data ?? []) as { person_id: string | null }[]).map((c) => c.person_id)].filter((x): x is string => !!x))];
  const people = personIds.length ? await supabase.from("people").select("id, first_name, last_name").in("id", personIds) : { data: [] };
  const name = (pid: string | null) => {
    const p = (people.data ?? []).find((x) => x.id === pid) as { first_name: string | null; last_name: string | null } | undefined;
    return p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "Client";
  };
  const rows = (ideas.data ?? []) as (Idea & { author_kind: string; author_person: string | null })[];
  const cs = (comments.data ?? []) as { id: string; idea_id: string; body: string; created_at: string; author_kind: string; person_id: string | null }[];
  const ts = (tasks.data ?? []) as { id: string; idea_id: string }[];
  return (
    <AdminIdeas
      projectId={id}
      ideas={rows.map((i) => ({
        ...i,
        author: i.author_kind === "owner" ? "Vous" : name(i.author_person),
        has_task: ts.some((t) => t.idea_id === i.id),
        task_id: ts.find((t) => t.idea_id === i.id)?.id ?? null,
        comments: cs.filter((c) => c.idea_id === i.id).map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, author: c.author_kind === "owner" ? "Vous" : name(c.person_id) })),
      }))}
    />
  );
}
