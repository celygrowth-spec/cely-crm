// Lecture des fichiers de la fiche par le connecteur : texte extrait côté serveur, par tranches ; aucun lien à ouvrir.
// Un fichier d'une autre fiche n'est jamais lu, même avec un identifiant valide.
import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { FILE_READ, readDossierFile } from "@/lib/crm/diagnostic";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docx = (paras: string[]) => zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(`<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`),
});
function pdf(text: string) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const DOSSIER = "7da410d4-26e1-4f74-89fa-cc0512614f28";
const ACME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = { id: string; company_id: string; status: string; display_name: string; mime_type: string; size_bytes: number; storage_path: string };

/** Client Supabase réduit : filtres eq réellement appliqués, stockage en mémoire, téléchargements comptés. */
function client(rows: Row[], objects: Record<string, Uint8Array>) {
  const downloads: string[] = [];
  const sb = {
    rpc: async (fn: string) => (fn === "diagnostic_company" ? { data: ACME, error: null } : { data: null, error: { message: "inconnu" } }),
    from: () => {
      const filters: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({ data: rows.find((r) => filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null, error: null }),
      };
      return q;
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          return objects[path] ? { data: new Blob([objects[path] as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } };
        },
      }),
    },
  };
  return { sb: sb as never, downloads };
}

const file = (n: number, name: string, mime: string, data: Uint8Array | null, extra: Partial<Row> = {}) => ({
  row: { id: id(n), company_id: ACME, status: "ready", display_name: name, mime_type: mime, size_bytes: data?.length ?? 10, storage_path: `${ACME}/${n}`, ...extra },
  data,
});

describe("lecture d'un fichier de la fiche", () => {
  const files = [
    file(1, "Audit SEO.pdf", "application/pdf", pdf("Trafic organique : 1 200 visites par mois")),
    file(2, "Brief.docx", DOCX, docx(["Objectif : 30 rendez-vous qualifiés", "Budget : 2 000 € par mois"])),
    file(3, "Notes.txt", "text/plain", new TextEncoder().encode("Le prospect vend des machines-outils en Rhône-Alpes.")),
    file(4, "Logo.png", "image/png", new Uint8Array([137, 80, 78, 71])),
    file(5, "Archive.zip", "application/zip", new Uint8Array([80, 75, 3, 4])),
    file(6, "Énorme.pdf", "application/pdf", null, { size_bytes: FILE_READ.maxBytes + 1 }),
    file(7, "Long.txt", "text/plain", new TextEncoder().encode("abcdefghij".repeat(110_000))),
    file(8, "Corrompu.pdf", "application/pdf", new Uint8Array([1, 2, 3])),
    file(9, "Autre fiche.txt", "text/plain", new TextEncoder().encode("Secret d'une autre fiche, à ne jamais lire."), { company_id: OTHER }),
  ];
  const setup = () => client(files.map((f) => f.row), Object.fromEntries(files.filter((f) => f.data).map((f) => [f.row.storage_path, f.data!])));

  test("PDF, Word et texte : contenu renvoyé directement, sans lien", async () => {
    const { sb } = setup();
    const a = await readDossierFile(sb, DOSSIER, id(1));
    expect(a).toMatchObject({ statut: "lu", nom: "Audit SEO.pdf", type: "application/pdf", suite_offset: null });
    expect(a.texte).toContain("1 200 visites par mois");
    expect(JSON.stringify(a)).not.toMatch(/https?:\/\//);
    expect((await readDossierFile(sb, DOSSIER, id(2))).texte).toContain("Budget : 2 000 € par mois");
    expect((await readDossierFile(sb, DOSSIER, id(3))).texte).toBe("Le prospect vend des machines-outils en Rhône-Alpes.");
  });

  test("image ou archive : nom, type et « contenu non lisible », sans téléchargement", async () => {
    const { sb, downloads } = setup();
    for (const [n, name, type] of [[4, "Logo.png", "image/png"], [5, "Archive.zip", "application/zip"]] as const)
      expect(await readDossierFile(sb, DOSSIER, id(n))).toEqual({ id: id(n), nom: name, type, taille_octets: 4, statut: "non_lisible", raison: expect.stringMatching(/^contenu non lisible/) });
    expect(downloads).toEqual([]);
  });

  test("fichier trop gros : non téléchargé ; document très long : tronqué, signalé et lu par tranches", async () => {
    const { sb, downloads } = setup();
    expect(await readDossierFile(sb, DOSSIER, id(6))).toMatchObject({ statut: "non_lisible", raison: expect.stringMatching(/trop volumineux/) });
    expect(downloads).toEqual([]);
    const p1 = await readDossierFile(sb, DOSSIER, id(7));
    expect(p1).toMatchObject({ statut: "lu", total_caracteres: FILE_READ.maxChars, debut: 0, fin: FILE_READ.pageChars, suite_offset: FILE_READ.pageChars, tronque: expect.stringMatching(/premiers caractères/) });
    expect(p1.texte).toHaveLength(FILE_READ.pageChars);
    const last = await readDossierFile(sb, DOSSIER, id(7), FILE_READ.maxChars - 5);
    expect(last).toMatchObject({ debut: FILE_READ.maxChars - 5, fin: FILE_READ.maxChars, suite_offset: null, texte: "fghij" });
  });

  test("fichier corrompu ou absent du stockage : échec avec la raison", async () => {
    const { sb } = setup();
    expect(await readDossierFile(sb, DOSSIER, id(8))).toMatchObject({ statut: "echec", raison: expect.stringMatching(/Lecture impossible/) });
    const broken = client([{ ...files[2].row }], {});
    expect(await readDossierFile(broken.sb, DOSSIER, id(3))).toMatchObject({ statut: "echec", raison: expect.stringMatching(/absent du stockage/) });
  });

  test("fichier d'une autre fiche ou identifiant manipulé : refusé, rien n'est téléchargé", async () => {
    const { sb, downloads } = setup();
    await expect(readDossierFile(sb, DOSSIER, id(9))).rejects.toThrow("Fichier introuvable sur cette fiche.");
    await expect(readDossierFile(sb, DOSSIER, id(99))).rejects.toThrow("Fichier introuvable sur cette fiche.");
    await expect(readDossierFile(sb, DOSSIER, "../../etc/passwd")).rejects.toThrow();
    expect(downloads).toEqual([]);
  });
});
