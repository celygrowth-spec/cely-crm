import "server-only";
// Lectures d'administration du module Projets (session du propriétaire, sous RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { Member, PortalAccess, Project } from "./types";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

export async function listProjects(sb: SupabaseClient, opts: { archived?: boolean; companyId?: string } = {}): Promise<Project[]> {
  let q = sb.from("project_overview").select("*");
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  else q = opts.archived ? q.eq("status", "archive") : q.neq("status", "archive");
  return check(await q.order("updated_at", { ascending: false }).limit(300)) as Project[];
}

export async function getProject(sb: SupabaseClient, id: string): Promise<Project | null> {
  return check(await sb.from("project_overview").select("*").eq("id", id).maybeSingle()) as Project | null;
}

export async function projectMembers(sb: SupabaseClient, projectId: string): Promise<Member[]> {
  const ids = (check(await sb.from("project_members").select("person_id").eq("project_id", projectId).order("added_at")) as { person_id: string }[]).map((m) => m.person_id);
  if (!ids.length) return [];
  const [people, accesses] = await Promise.all([
    sb.from("people").select("id, first_name, last_name, email").in("id", ids),
    sb.from("portal_accesses").select("id, person_id, code_hint, code_generated_at, expires_at, revoked_at, last_used_at").in("person_id", ids),
  ]);
  const ppl = check(people) as { id: string; first_name: string | null; last_name: string | null; email: string | null }[];
  const acc = check(accesses) as PortalAccess[];
  return ids.map((id) => {
    const p = ppl.find((x) => x.id === id);
    return { person_id: id, first_name: p?.first_name ?? null, last_name: p?.last_name ?? null, email: p?.email ?? null, access: acc.find((a) => a.person_id === id) ?? null };
  });
}

export async function companyPeople(sb: SupabaseClient, companyId: string) {
  return check(await sb.from("people").select("id, first_name, last_name, email").eq("company_id", companyId).order("is_primary", { ascending: false }).order("created_at")) as {
    id: string; first_name: string | null; last_name: string | null; email: string | null;
  }[];
}
