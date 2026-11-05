"use server";

// Server actions du module Projets (administration). Les règles fortes (appartenance des contacts,
// invalidation des sessions, journal) sont appliquées en base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { appUrl } from "@/lib/appointments/config";
import { codeHash, generateCode } from "@/lib/projects/portal-auth";
import { companyPeople } from "@/lib/projects/owner";
import { projectCreateSchema, projectPatchSchema, type ProjectCreateInput, type ProjectPatch } from "@/lib/projects/schemas";

function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}
const idv = (id: string) => v(z.uuid("Identifiant invalide"), id);
async function rpc<T = unknown>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
async function origin() {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return appUrl(host ? `${proto}://${host}` : null);
}

export async function createProjectAction(input: ProjectCreateInput) {
  return run(async (sb) => {
    const d = v(projectCreateSchema, input);
    const { person_ids, ...data } = d;
    return { id: await rpc<string>(sb, "project_create", { p_data: data, p_person_ids: person_ids }) };
  });
}

export async function updateProjectAction(id: string, patch: ProjectPatch) {
  return run(async (sb) => {
    const p = v(projectPatchSchema, patch) as Record<string, unknown>;
    if (p.status === "archive") p.archived_at = new Date().toISOString();
    else if (p.status) p.archived_at = null;
    const { error } = await sb.from("projects").update(p).eq("id", idv(id));
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function companyPeopleAction(companyId: string) {
  return run((sb) => companyPeople(sb, idv(companyId)));
}

export async function addMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await rpc(sb, "project_add_member", { p_project: idv(projectId), p_person: idv(personId) });
  });
}

export async function removeMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await rpc(sb, "project_remove_member", { p_project: idv(projectId), p_person: idv(personId) });
  });
}

/**
 * Génère (ou régénère) le code d'accès d'une personne. Le code n'est renvoyé qu'ici, une seule fois :
 * la base n'en garde que l'empreinte. Régénérer invalide l'ancien code et ferme les sessions ouvertes.
 */
export async function issueAccessAction(personId: string, expiresAt: string | null) {
  return run(async (sb) => {
    const exp = expiresAt ? v(z.iso.datetime({ offset: true }), expiresAt) : null;
    const { code, hint } = generateCode();
    await rpc(sb, "portal_access_issue", { p_person: idv(personId), p_code_hash: codeHash(code), p_code_hint: hint, p_expires_at: exp });
    return { code, url: `${await origin()}/portail` };
  });
}

export async function setAccessExpiryAction(personId: string, expiresAt: string | null) {
  return run(async (sb) => {
    await rpc(sb, "portal_access_set_expiry", { p_person: idv(personId), p_expires_at: expiresAt ? v(z.iso.datetime({ offset: true }), expiresAt) : null });
  });
}

export async function revokeAccessAction(personId: string) {
  return run(async (sb) => {
    await rpc(sb, "portal_access_revoke", { p_person: idv(personId) });
  });
}
