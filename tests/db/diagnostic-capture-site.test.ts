// Capture du site rattachée au dossier : une seule à la fois (double clic), une nouvelle datée à chaque relance,
// écrite par l'application seulement ; un autre compte ne lit ni la capture ni les fichiers de la fiche.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let acme: string;
let dossier: string;

beforeEach(async () => {
  db = await createDb();
  await db.as("owner");
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "1-One", website: "1-one.fr" }, p_people: [] })).id;
  dossier = await db.rpc<string>("diagnostic_start", { p_company: acme, p_key: "cle-1one-1" });
});

const claim = (onlyIfNone = false) => db.rpc<string | null>("diagnostic_site_capture_claim", { p_id: dossier, p_only_if_none: onlyIfNone });
const save = (capture: string, status = "ok", pages: unknown[] = [{ url: "https://1-one.fr/", titre: "Accueil", texte: "Bonjour", tronque: false, capture_le: "2026-11-16T10:00:00Z" }], error: string | null = null) =>
  db.rpc("diagnostic_site_capture_save", { p_capture: capture, p_status: status, p_site_url: "https://1-one.fr/", p_error: error, p_pages: JSON.stringify(pages) });

describe("capture du site d'un dossier", () => {
  test("double clic : une seule capture en cours", async () => {
    const first = await claim();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim()).toBeNull();
    expect(await claim(true)).toBeNull();
    await save(first!);
    expect(await db.one(`select count(*)::int n, min(status) s from diagnostic_site_captures`)).toEqual({ n: 1, s: "ok" });
  });

  test("relance : nouvelle capture datée, la plus récente fait foi ; « seulement si aucune » ne recapture pas", async () => {
    await save((await claim())!);
    expect(await claim(true)).toBeNull();
    const second = (await claim())!;
    await save(second, "failed", [], "Page d'accueil (https://1-one.fr/) : délai dépassé");
    const rows = (await db.query<{ status: string; error: string | null; captured_at: string | null }>(
      `select status, error, captured_at from diagnostic_site_captures where diagnostic_id = $1 order by created_at desc, captured_at desc`, [dossier])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.captured_at)).toBe(true);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "ok"]);
  });

  test("une capture restée « en cours » (serveur interrompu) ne bloque pas au-delà de deux minutes", async () => {
    const stuck = (await claim())!;
    await db.exec(`reset role; update diagnostic_site_captures set created_at = now() - interval '3 minutes' where id = '${stuck}';`);
    await db.as("owner");
    expect(await claim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("statut, taille et capture déjà enregistrée contrôlés", async () => {
    const c = (await claim())!;
    await expect(save(c, "bidon")).rejects.toThrow(/Statut invalide/);
    await expect(save(c, "ok", Array.from({ length: 11 }, () => ({})))).rejects.toThrow(/trop volumineuse/);
    await save(c);
    await expect(save(c)).rejects.toThrow(/introuvable/);
  });

  test("Claude lit la capture mais ne l'écrit pas ; un autre compte n'a accès à rien", async () => {
    await save((await claim())!);
    await db.as("claude");
    expect(await db.one(`select count(*)::int n from diagnostic_site_captures`)).toEqual({ n: 1 });
    await expect(claim()).rejects.toThrow(/Claude/);
    await db.as("stranger");
    expect(await db.one(`select count(*)::int n from diagnostic_site_captures`)).toEqual({ n: 0 });
    await expect(claim()).rejects.toThrow();
    await expect(db.query(`insert into diagnostic_site_captures (diagnostic_id) values ($1)`, [dossier])).rejects.toThrow();
  });

  test("dossier inconnu : refusé", async () => {
    await expect(db.rpc("diagnostic_site_capture_claim", { p_id: crypto.randomUUID(), p_only_if_none: false })).rejects.toThrow(/introuvable/);
  });
});

describe("fichiers de la fiche : mêmes règles d'accès que l'interface", () => {
  test("un autre compte ne trouve ni le dossier, ni le fichier, ni l'objet stocké, même avec leurs identifiants", async () => {
    await db.exec(`reset role;`);
    const f = await db.one<{ id: string }>(
      `insert into company_files (company_id, display_name, mime_type, size_bytes, storage_path, status) values ($1, 'Audit.pdf', 'application/pdf', 10, $2, 'ready') returning id`,
      [acme, `${acme}/audit.pdf`]);
    await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme}/audit.pdf`]);
    await db.as("claude");
    expect(await db.rpc("diagnostic_company", { p_id: dossier })).toBe(acme);
    expect(await db.one(`select count(*)::int n from company_files where id = $1 and company_id = $2`, [f.id, acme])).toEqual({ n: 1 });
    expect(await db.one(`select count(*)::int n from storage.objects where bucket_id = 'company-files'`)).toEqual({ n: 1 });
    await db.as("stranger");
    await expect(db.rpc("diagnostic_company", { p_id: dossier })).rejects.toThrow();
    expect(await db.one(`select count(*)::int n from company_files where id = $1`, [f.id])).toEqual({ n: 0 });
    expect(await db.one(`select count(*)::int n from storage.objects where bucket_id = 'company-files'`)).toEqual({ n: 0 });
  });
});
