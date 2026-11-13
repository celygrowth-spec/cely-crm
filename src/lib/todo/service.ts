import "server-only";
// Productivité › To do list : lectures et écritures. Les droits (propriétaire dans l'application), l'urgence
// autorisée et la fiche liée sont contrôlés par la base ; ces schémas donnent seulement un message clair plus tôt.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { DEFAULT_URGENCY, URGENCIES, type TodoItem, type Urgency } from "./types";

const id = z.uuid("Identifiant invalide");
const title = z.string("Titre manquant").trim().min(1, "Donnez un titre à la tâche").max(300, "300 caractères maximum");
const urgency = z.enum(URGENCIES, "Urgence inconnue");
const company = id.nullable();

export const createSchema = z.object({ id, title, urgency: urgency.default(DEFAULT_URGENCY), company_id: company.default(null) });
export const patchSchema = z
  .object({ title, urgency, company_id: company, done: z.boolean() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Rien à modifier");

type Row = { id: string; title: string; urgency: Urgency; company_id: string | null; done_at: string | null; created_at: string };
const COLS = "id, title, urgency, company_id, done_at, created_at";

function fail(error: { message: string; code?: string } | null) {
  if (error) throw new CrmError(friendlyError(error));
}

/** Ajoute le nom de la fiche liée (illisible si elle est à la corbeille : la tâche reste, sans lien). */
async function withCompanies(sb: SupabaseClient, rows: Row[]): Promise<TodoItem[]> {
  const ids = [...new Set(rows.map((r) => r.company_id).filter((x): x is string => !!x))];
  const res = ids.length ? await sb.from("companies").select("id, name, archived_at").in("id", ids) : { data: [], error: null };
  fail(res.error);
  const byId = new Map(((res.data ?? []) as { id: string; name: string; archived_at: string | null }[]).map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = r.company_id ? byId.get(r.company_id) : undefined;
    return { ...r, company_name: c?.name ?? null, company_archived: !!c?.archived_at };
  });
}

/** Toute la liste, ou les tâches d'une fiche (`openOnly` : seulement celles à faire). */
export async function listTodos(sb: SupabaseClient, opts: { companyId?: string | null; openOnly?: boolean } = {}): Promise<TodoItem[]> {
  let q = sb.from("todo_list_items").select(COLS);
  if (opts.companyId) q = q.eq("company_id", id.parse(opts.companyId));
  if (opts.openOnly) q = q.is("done_at", null);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(2000);
  fail(error);
  return withCompanies(sb, (data ?? []) as Row[]);
}

/** Création sans doublon : le même identifiant renvoie la tâche déjà créée. */
export async function createTodo(sb: SupabaseClient, input: unknown): Promise<TodoItem> {
  const p = createSchema.parse(input);
  const { data, error } = await sb.rpc("todo_list_create", { p_id: p.id, p_title: p.title, p_urgency: p.urgency, p_company: p.company_id });
  fail(error);
  return (await withCompanies(sb, [data as Row]))[0];
}

export async function updateTodo(sb: SupabaseClient, todoId: string, input: unknown): Promise<TodoItem> {
  const p = patchSchema.parse(input);
  const row: Record<string, unknown> = {};
  if (p.title !== undefined) row.title = p.title;
  if (p.urgency !== undefined) row.urgency = p.urgency;
  if (p.company_id !== undefined) row.company_id = p.company_id;
  if (p.done !== undefined) row.done_at = p.done ? new Date().toISOString() : null;
  const { data, error } = await sb.from("todo_list_items").update(row).eq("id", id.parse(todoId)).select(COLS);
  fail(error);
  const rows = (data ?? []) as Row[];
  // aucune ligne : tâche à la corbeille, supprimée ou d'un autre compte — jamais présenté comme réussi
  if (!rows.length) throw new CrmError("Tâche introuvable : elle a peut-être été supprimée. Rechargez la page.");
  return (await withCompanies(sb, rows))[0];
}
