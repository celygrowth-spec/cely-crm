// Prompt de diagnostic : le livrable devient un PDF ; un prompt réécrit par l'utilisateur n'est pas écrasé.
import { describe, expect, test } from "vitest";
import { applyMigrations, createDb } from "./harness";

const BEFORE = "20261121004700";
const instructions = async (db: Awaited<ReturnType<typeof createDb>>) =>
  (await db.one<{ instructions: string }>(`select instructions from diagnostic_settings`)).instructions;

describe("prompt de diagnostic : livrable PDF", () => {
  test("le prompt d'origine demande un PDF 16:9, une slide par page, et ne parle plus du .pptx", async () => {
    const db = await createDb();
    const text = await instructions(db);
    expect(text).not.toMatch(/\.pptx/);
    expect(text).toContain("exporte-le en un fichier PDF, une slide par page, au format paysage 16:9");
    expect(text).toContain("Dépose le PDF avec start_diagnostic_version");
    expect(text).toContain("Format 16:9"); // le reste du prompt est intact
  });

  test("un prompt réécrit par l'utilisateur garde son texte", async () => {
    const db = await createDb({ upTo: BEFORE });
    await db.exec(`reset role; update diagnostic_settings set instructions = 'Mon prompt à moi, sans format imposé.' where id;`);
    await applyMigrations(db, { after: BEFORE });
    expect(await instructions(db)).toBe("Mon prompt à moi, sans format imposé.");
  });
});
