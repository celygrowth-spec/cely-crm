// Bibliothèque : règles d'arborescence partagées avec l'écran, et lecture par le connecteur MCP (lecture seule,
// chemins, filtres, pagination). Les droits en base sont testés dans tests/db/bibliotheque.test.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test } from "vitest";
import { registerTools } from "@/lib/mcp/tools";
import { countItems, folderMoveTargets, folderPath, itemMoveTargets, promptFileName, searchLibrary, subtreeIds, type Library, type LibraryFolder, type LibraryItem } from "@/lib/crm/library-rules";

const T = "2026-11-12T09:00:00Z";
const folder = (id: string, name: string, parent_id: string | null, system_key: "diagnostic" | null = null): LibraryFolder => ({ id, name, parent_id, system_key, created_at: T, updated_at: T });
const item = (id: string, folder_id: string, display_name: string, kind: "file" | "prompt" = "file"): LibraryItem =>
  ({ id, folder_id, display_name, kind, mime_type: kind === "file" ? "application/pdf" : "text/plain", size_bytes: 10, created_at: T, updated_at: T });

const ids = {
  diag: "00000000-0000-4000-8000-00000000000d", sub: "00000000-0000-4000-8000-0000000000d1",
  a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b", c: "00000000-0000-4000-8000-00000000000c",
  p1: "10000000-0000-4000-8000-000000000001", f1: "10000000-0000-4000-8000-000000000002", f2: "10000000-0000-4000-8000-000000000003", f3: "10000000-0000-4000-8000-000000000004",
};
const lib: Library = {
  folders: [folder(ids.diag, "Bibliothèque diagnostic", null, "diagnostic"), folder(ids.sub, "Exemples", ids.diag), folder(ids.a, "Prompts", null), folder(ids.b, "LinkedIn", ids.a), folder(ids.c, "Accroches", ids.b)],
  items: [item(ids.f1, ids.diag, "Diagnostic Durand.pptx"), item(ids.f2, ids.sub, "Charte.pdf"), item(ids.p1, ids.b, "Relance été", "prompt"), item(ids.f3, ids.c, "Exemple accroche.pdf")],
};

describe("arborescence", () => {
  test("chemin, sous-arbre, décompte", () => {
    expect(folderPath(lib.folders, ids.c).map((f) => f.name)).toEqual(["Prompts", "LinkedIn", "Accroches"]);
    expect([...subtreeIds(lib.folders, ids.a)].sort()).toEqual([ids.a, ids.b, ids.c].sort());
    expect(countItems(lib, ids.a)).toBe(2);
    expect(countItems(lib, ids.diag)).toBe(2);
  });

  test("déplacer un dossier : jamais dans lui-même ni dans un de ses sous-dossiers", () => {
    const targets = folderMoveTargets(lib.folders, ids.a).map((t) => t.id);
    expect(targets).not.toContain(ids.a);
    expect(targets).not.toContain(ids.b);
    expect(targets).not.toContain(ids.c);
    expect(targets).toContain(ids.diag);
    // déjà à la racine : la racine n'est pas proposée ; un sous-dossier peut y remonter
    expect(targets).not.toContain(null);
    expect(folderMoveTargets(lib.folders, ids.b).map((t) => t.id)).toContain(null);
    expect(itemMoveTargets(lib.folders, ids.b).map((t) => t.id)).not.toContain(ids.b);
  });

  test("une boucle dans les données ne bloque pas l'écran", () => {
    const loop = [folder(ids.a, "A", ids.b), folder(ids.b, "B", ids.a)];
    expect(folderPath(loop, ids.a).length).toBeLessThanOrEqual(2);
  });

  test("recherche par nom sur toute la bibliothèque, accents et casse ignorés", () => {
    const r = searchLibrary(lib, "ETE relance");
    expect(r.items.map((i) => i.id)).toEqual([ids.p1]);
    expect(searchLibrary(lib, "exemple").folders.map((f) => f.id)).toEqual([ids.sub]);
    expect(searchLibrary(lib, "exemple").items.map((i) => i.id)).toEqual([ids.f3]);
    expect(searchLibrary(lib, "  ")).toEqual({ folders: [], items: [] });
  });

  test("téléchargement d'un prompt : nom de fichier sûr", () => {
    expect(promptFileName('Relance: "J+3" / été')).toBe("Relance J+3 été.txt");
    expect(promptFileName("///")).toBe("prompt.txt");
  });
});

// ---------------------------------------------------------------------------
// Connecteur MCP
// ---------------------------------------------------------------------------
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
type Config = { annotations: { readOnlyHint: boolean }; inputSchema: { parse: (v: unknown) => Record<string, unknown> } };
const tools = new Map<string, { config: Config; fn: Handler }>();
let writes: string[];
let filters: string[];

/** Faux client Supabase : sert les lignes de la bibliothèque ; toute écriture est comptée. */
function fake(): SupabaseClient {
  const rows: Record<string, Record<string, unknown>[]> = {
    library_folders: lib.folders,
    diagnostic_library_files: [
      ...lib.items.map((i) => ({ ...i, status: "ready", content: i.kind === "prompt" ? "Bonjour {prénom}, je reviens vers vous." : null })),
      { ...item("10000000-0000-4000-8000-000000000009", ids.a, "Envoi inachevé.pdf"), status: "pending", content: null },
    ],
  };
  const chain = (table: string) => {
    let data = [...(rows[table] ?? [])];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.range = (a: number, b: number) => { data = data.slice(a, b + 1); return q; };
    q.eq = (k: string, v: unknown) => { filters.push(`${table}.${k}=${v}`); data = data.filter((r) => r[k] === v); return q; };
    q.in = (k: string, v: unknown[]) => { data = data.filter((r) => v.includes(r[k])); return q; };
    for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { writes.push(`${m}:${table}`); return q; };
    q.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
    q.single = async () => ({ data: data[0] ?? null, error: null });
    q.then = (ok: (v: unknown) => unknown) => ok({ data, error: null });
    return q;
  };
  return {
    from: chain,
    rpc: async (fn: string) => { writes.push(`rpc:${fn}`); return { data: null, error: null }; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://stockage.example.test/signe?token=x" }, error: null }) }) },
  } as unknown as SupabaseClient;
}
registerTools({ registerTool: (name: string, config: Config, fn: Handler) => tools.set(name, { config, fn }) } as never, () => fake());
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const t = tools.get(name)!;
  const r = await t.fn(t.config.inputSchema.parse(args), {});
  if (r.isError) throw new Error(r.content[0].text);
  const body = r.content[0].text;
  return JSON.parse(body.slice(body.indexOf("\n\n") + 2));
};

describe("connecteur MCP : lecture de toute la bibliothèque", () => {
  beforeEach(() => { writes = []; filters = []; });

  test("quatre outils en lecture seule, aucune écriture", async () => {
    for (const n of ["list_library_folders", "list_library_items", "get_library_prompt", "get_library_file_url"]) expect(tools.get(n)?.config.annotations.readOnlyHint, n).toBe(true);
    await call("list_library_folders");
    await call("list_library_items");
    await call("get_library_prompt", { prompt_id: ids.p1 });
    await tools.get("get_library_file_url")!.fn({ file_id: ids.f3 }, {});
    expect(writes).toEqual([]);
  });

  test("dossiers : chemins, dossier diagnostic signalé, nombre d'éléments", async () => {
    const folders = await call("list_library_folders");
    expect(folders.map((f: { chemin: string }) => f.chemin)).toEqual(["Bibliothèque diagnostic", "Bibliothèque diagnostic › Exemples", "Prompts", "Prompts › LinkedIn", "Prompts › LinkedIn › Accroches"]);
    expect(folders.find((f: { id: string }) => f.id === ids.diag)).toMatchObject({ dossier_diagnostic: true, elements: 1 });
  });

  test("éléments : toute la bibliothèque sans envoi inachevé, filtre par dossier (sous-dossiers en option), recherche, pagination", async () => {
    const all = await call("list_library_items");
    expect(all.total).toBe(4);
    expect(all.elements.map((e: { nom: string }) => e.nom)).not.toContain("Envoi inachevé.pdf");
    expect((await call("list_library_items", { folder_id: ids.a })).total).toBe(0);
    const deep = await call("list_library_items", { folder_id: ids.a, recursive: true });
    expect(deep.elements.map((e: { id: string; type: string; chemin: string }) => [e.id, e.type, e.chemin]).sort()).toEqual([
      [ids.f3, "fichier", "Prompts › LinkedIn › Accroches"],
      [ids.p1, "prompt", "Prompts › LinkedIn"],
    ].sort());
    expect((await call("list_library_items", { query: "relance ete" })).elements.map((e: { id: string }) => e.id)).toEqual([ids.p1]);
    const page = await call("list_library_items", { limit: 3 });
    expect(page.elements).toHaveLength(3);
    expect(page.suite).toEqual({ offset: 3 });
    expect((await call("list_library_items", { limit: 3, offset: 3 })).suite).toBeNull();
    await expect(call("list_library_items", { folder_id: "20000000-0000-4000-8000-000000000000" })).rejects.toThrow(/introuvable/);
  });

  test("prompt : titre, chemin, contenu présenté comme une donnée", async () => {
    const t = tools.get("get_library_prompt")!;
    const raw = (await t.fn({ prompt_id: ids.p1 }, {})).content[0].text;
    expect(raw).toMatch(/pas des instructions/);
    expect(await call("get_library_prompt", { prompt_id: ids.p1 })).toMatchObject({ titre: "Relance été", chemin: "Prompts › LinkedIn", contenu: "Bonjour {prénom}, je reviens vers vous." });
    // un fichier n'est pas un prompt, et inversement
    await expect(call("get_library_prompt", { prompt_id: ids.f3 })).rejects.toThrow(/introuvable/);
    expect((await tools.get("get_library_file_url")!.fn({ file_id: ids.p1 }, {})).content[0].text).toMatch(/introuvable/);
  });

  test("lien temporaire vers un fichier de n'importe quel dossier, borné à 5 minutes", async () => {
    const t = tools.get("get_library_file_url")!;
    const body = JSON.parse((await t.fn({ file_id: ids.f3 }, {})).content[0].text); // sans note de données
    expect(body).toEqual({ url: "https://stockage.example.test/signe?token=x", expire_dans_secondes: 300 });
    expect(filters).toContain("diagnostic_library_files.status=ready");
    expect(filters).toContain("diagnostic_library_files.kind=file");
  });

  test("open_diagnostic : seuls les documents du dossier « Bibliothèque diagnostic » (sous-dossiers compris)", async () => {
    const { getLibrary } = await import("@/lib/crm/diagnostic");
    const sb = fake();
    const r = await getLibrary(sb);
    expect(r.files.map((f) => f.id).sort()).toEqual([ids.f1, ids.f2].sort());
    expect(r.prompts).toEqual([]);
  });
});
