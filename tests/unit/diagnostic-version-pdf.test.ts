// Livrable du diagnostic : une version n'est reçue que si le fichier déposé est un PDF lisible.
// Un autre format est refusé avec un message que la session peut appliquer, et le dépôt reste ouvert.
import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { checkDeckPdf, confirmVersion, startVersion } from "@/lib/crm/diagnostic";

/** PDF minimal : `pages` pages de `w` × `h` points, une ligne de texte chacune. */
function pdf(pages = 2, w = 960, h = 540) {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: number[] = [];
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 24 Tf 72 400 Td (Slide ${i + 1}) Tj ET`;
    const pageNo = objs.length + 1;
    kids.push(pageNo);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${pageNo + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  const font = objs.length + 1;
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o.replace("FONT", String(font))}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(out);
}
const pptx = () => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": strToU8("<p:presentation/>") });

const DOSSIER = "7da410d4-26e1-4f74-89fa-cc0512614f28";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const FILE = "33333333-3333-4333-8333-333333333333";

/** Client Supabase réduit : une version en dépôt, son fichier, le stockage ; écritures et appels enregistrés. */
function client(opts: { stored?: Uint8Array; pendingMime?: string | null } = {}) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const files: Record<string, { storage_path: string; mime_type: string; status: string }> = {};
  if (opts.pendingMime) files[FILE] = { storage_path: `${COMPANY}/${FILE}.x`, mime_type: opts.pendingMime, status: "pending" };
  const sb = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(fn);
      if (fn === "diagnostic_version_open") return { data: { id: "v2", version: 2, file_id: opts.pendingMime ? FILE : null, company_id: COMPANY }, error: null };
      if (fn === "diagnostic_version_attach") calls.push(`attach:${args.p_file}`);
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      let insert: Record<string, unknown> | null = null;
      let del = false;
      const result = () => {
        if (insert) { files[insert.id as string] = insert as never; return { data: null, error: null }; }
        if (del) { delete files[filters.id as string]; calls.push(`delete:${filters.id}`); return { data: null, error: null }; }
        if (patch) { updates.push(patch); if (files[filters.id as string]) Object.assign(files[filters.id as string], patch); return { data: { id: filters.id }, error: null }; }
        if (table === "diagnostic_versions") return { data: { file_id: FILE }, error: null };
        const f = files[filters.id as string] ?? (table === "company_files" ? { storage_path: `${COMPANY}/${FILE}.pdf`, mime_type: "application/pdf", status: "pending" } : null);
        return { data: f && { id: filters.id, ...f }, error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        insert: (row: Record<string, unknown>) => ((insert = row), q),
        delete: () => ((del = true), q),
        single: async () => result(),
        maybeSingle: async () => result(),
        then: (ok: (r: unknown) => unknown) => Promise.resolve(result()).then(ok),
      };
      return q;
    },
    storage: {
      from: () => ({
        download: async () => (opts.stored ? { data: new Blob([opts.stored as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } }),
        createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `https://stockage.test/upload/${path}` }, error: null }),
        remove: async () => ({ data: [], error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://stockage.test/lien" }, error: null }),
      }),
    },
  };
  return { sb: sb as never, calls, updates, files };
}

describe("contrôle du PDF déposé", () => {
  test("PDF paysage 16:9 accepté, avec le nombre de pages", async () => {
    expect(await checkDeckPdf(pdf(3))).toEqual({ pages: 3, format: "3 page(s), 960 × 540 pt, paysage 16:9" });
  });

  test("PowerPoint, image, texte ou faux PDF refusés avec la marche à suivre", async () => {
    await expect(checkDeckPdf(pptx())).rejects.toThrow(/n'est pas.*|PowerPoint \.pptx \?\)\. Le livrable du diagnostic doit être un PDF\. Exportez le support en PDF/);
    await expect(checkDeckPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).rejects.toThrow(/fichier qui n'est pas un PDF.*refaites le dépôt/);
    await expect(checkDeckPdf(strToU8("%PDF-1.4 tronqué"))).rejects.toThrow(/illisible ou incomplet/);
  });

  test("autre format de page : version acceptée, avertissement renvoyé à la session", async () => {
    const r = await checkDeckPdf(pdf(1, 595, 842));
    expect(r).toMatchObject({ pages: 1, avertissement: expect.stringMatching(/paysage 16:9/) });
  });
});

describe("dépôt d'une version", () => {
  test("PDF accepté : version reçue, taille réelle et type PDF enregistrés", async () => {
    const file = pdf(2);
    const { sb, calls, updates } = client({ stored: file });
    const r = await confirmVersion(sb, DOSSIER, 2);
    expect(r).toEqual({ version: 2, taille_recue: file.length, format: "2 page(s), 960 × 540 pt, paysage 16:9" });
    expect(updates).toContainEqual({ size_bytes: file.length, mime_type: "application/pdf" });
    expect(calls).toContain("diagnostic_version_ready");
  });

  test("autre format refusé : message clair, rien n'est marqué reçu, le dépôt reste ouvert", async () => {
    const { sb, calls, updates } = client({ stored: pptx() });
    await expect(confirmVersion(sb, DOSSIER, 2)).rejects.toThrow(/Version refusée.*PDF.*start_diagnostic_version/);
    expect(calls).not.toContain("diagnostic_version_ready");
    expect(updates).toEqual([]);
  });

  test("rien reçu par le stockage : refusé", async () => {
    const { sb } = client({});
    await expect(confirmVersion(sb, DOSSIER, 2)).rejects.toThrow(/pas été reçu/);
  });

  test("nouvelle version : fichier .pdf préparé en type PDF", async () => {
    const { sb, files } = client({});
    const v = await startVersion(sb, DOSSIER, 1000, "1-One");
    expect(v.name).toBe("Diagnostic 1-One V2.pdf");
    expect(Object.values(files)).toEqual([expect.objectContaining({ mime_type: "application/pdf", display_name: "Diagnostic 1-One V2.pdf" })]);
  });

  test("dépôt .pptx resté en cours avant le passage au PDF : abandonné et remplacé par un dépôt PDF", async () => {
    const { sb, calls, files } = client({ pendingMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    const v = await startVersion(sb, DOSSIER, 1000, "1-One");
    expect(v.name).toMatch(/\.pdf$/);
    expect(calls).toContain(`delete:${FILE}`);
    expect(calls.some((c) => c.startsWith("attach:") && c !== `attach:${FILE}`)).toBe(true);
    expect(Object.values(files).map((f) => f.mime_type)).toEqual(["application/pdf"]);
  });

  test("dépôt PDF déjà en cours : repris tel quel", async () => {
    const { sb, calls } = client({ pendingMime: "application/pdf" });
    const v = await startVersion(sb, DOSSIER, 1000, "1-One");
    expect(v.uploadUrl).toContain(FILE);
    expect(calls.filter((c) => c.startsWith("attach:") || c.startsWith("delete:"))).toEqual([]);
  });
});
