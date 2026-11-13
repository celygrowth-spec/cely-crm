// Productivité › To do list : ordre d'affichage, validation des saisies, échecs jamais présentés comme réussis,
// navigation (Productivité › Temps et To do list).
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";
import { PRODUCTIVITE_NAV } from "@/components/app-shell";
import { createSchema, createTodo, patchSchema, updateTodo } from "@/lib/todo/service";
import { sortOpen, splitTodos, type TodoItem } from "@/lib/todo/types";

const t = (id: string, urgency: TodoItem["urgency"], created: string, done: string | null = null): TodoItem =>
  ({ id, title: id, urgency, company_id: null, company_name: null, company_archived: false, done_at: done, created_at: created });

describe("ordre", () => {
  test("Urgent, puis Moyen, puis Pas urgent ; à urgence égale, la plus récente d'abord", () => {
    const items = [t("p", "pas_urgent", "2026-11-13T10:00:00Z"), t("m-old", "moyen", "2026-11-01T10:00:00Z"), t("u", "urgent", "2026-11-02T10:00:00Z"), t("m-new", "moyen", "2026-11-12T10:00:00Z")];
    expect(sortOpen(items).map((x) => x.id)).toEqual(["u", "m-new", "m-old", "p"]);
  });
  test("les terminées sont à part, la dernière terminée d'abord", () => {
    const { open, done } = splitTodos([
      t("a", "urgent", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z"),
      t("b", "moyen", "2026-11-02T00:00:00Z"),
      t("c", "pas_urgent", "2026-11-03T00:00:00Z", "2026-11-06T00:00:00Z"),
    ]);
    expect(open.map((x) => x.id)).toEqual(["b"]);
    expect(done.map((x) => x.id)).toEqual(["c", "a"]);
  });
});

describe("validation", () => {
  const id = "3f1c2a4e-7b8d-4c9e-a1b2-c3d4e5f6a7b8";
  test("création : urgence « Moyen » et aucune fiche par défaut ; titre vide ou urgence inconnue refusés", () => {
    expect(createSchema.parse({ id, title: "  Appeler  " })).toEqual({ id, title: "Appeler", urgency: "moyen", company_id: null });
    expect(() => createSchema.parse({ id, title: "   " })).toThrow(/titre/);
    expect(() => createSchema.parse({ id, title: "x", urgency: "critique" })).toThrow(/Urgence inconnue/);
    expect(() => createSchema.parse({ id: "pas-un-uuid", title: "x" })).toThrow(/Identifiant invalide/);
    expect(() => createSchema.parse({ id, title: "x", company_id: "../companies" })).toThrow(/Identifiant invalide/);
  });
  test("modification : au moins un champ", () => {
    expect(() => patchSchema.parse({})).toThrow(/Rien à modifier/);
    expect(patchSchema.parse({ done: true })).toEqual({ done: true });
  });
});

/** Faux client Supabase : enregistre les appels et renvoie la réponse prévue. */
function fakeSb(opts: { rpc?: unknown; update?: unknown[]; error?: { message: string; code?: string } }) {
  const calls: unknown[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order", "limit", "update"]) q[m] = (...a: unknown[]) => { calls.push([m, ...a]); return q; };
    q.then = (resolve: (v: unknown) => void) => resolve(result);
    return q;
  };
  const sb = {
    rpc: async (fn: string, args: unknown) => { calls.push(["rpc", fn, args]); return { data: opts.rpc ?? null, error: opts.error ?? null }; },
    from: (table: string) => { calls.push(["from", table]); return chain(table === "companies" ? { data: [], error: null } : { data: opts.update ?? [], error: opts.error ?? null }); },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

describe("écritures", () => {
  const id = "3f1c2a4e-7b8d-4c9e-a1b2-c3d4e5f6a7b8";
  const row = { id, title: "x", urgency: "moyen", company_id: null, done_at: null, created_at: "2026-11-13T10:00:00Z" };
  test("création : passe l'identifiant choisi à la saisie (double validation sans doublon)", async () => {
    const { sb, calls } = fakeSb({ rpc: row });
    expect(await createTodo(sb, { id, title: "x" })).toMatchObject({ id, company_name: null });
    expect(calls).toContainEqual(["rpc", "todo_list_create", { p_id: id, p_title: "x", p_urgency: "moyen", p_company: null }]);
  });
  test("modification sans ligne touchée (supprimée, autre compte) : erreur claire, jamais un succès", async () => {
    const { sb } = fakeSb({ update: [] });
    await expect(updateTodo(sb, id, { done: true })).rejects.toThrow(/Tâche introuvable/);
  });
  test("erreur de la base : message transmis", async () => {
    const { sb } = fakeSb({ error: { message: "Fiche introuvable : choisissez une autre fiche.", code: "P0002" } });
    await expect(createTodo(sb, { id, title: "x", company_id: id })).rejects.toThrow(/Fiche introuvable/);
  });
});

describe("navigation", () => {
  test("Productivité contient Temps et To do list", () => {
    expect(PRODUCTIVITE_NAV).toEqual([{ href: "/productivite/temps", label: "Temps" }, { href: "/productivite/todo", label: "To do list" }]);
  });
});
