// K10 : lecture du contenu d'un document Word (.docx), d'un texte, d'un PDF ; formats non lus signalés.
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { strToU8, zipSync } from "fflate";
import { extractDocument } from "@/lib/documents/extract";

const docx = (paras: string[]) => zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(`<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`),
});

/** PDF minimal d'une page avec une ligne de texte (police standard). */
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

describe("lecture des documents", () => {
  test("Word : paragraphes lus", async () => {
    const r = await extractDocument(docx(["Proposition Studio", "Accompagnement mensuel : 1 000 € HT par mois", "Démarrage le 1er décembre"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "p.docx");
    expect(r.status).toBe("ok");
    expect(r.text).toContain("1 000 € HT par mois");
    expect(r.text!.split("\n")).toHaveLength(3);
  });
  test("PDF avec texte intégré : lu", async () => {
    const r = await extractDocument(pdf("Engagement : livraison du site en 6 semaines"), "application/pdf", "c.pdf");
    expect(r).toMatchObject({ status: "ok" });
    expect(r.text).toContain("livraison du site en 6 semaines");
  });
  test("format non lu, document vide ou illisible : statut et raison, jamais de texte inventé", async () => {
    expect(await extractDocument(new Uint8Array([1, 2, 3]), "application/vnd.ms-powerpoint", "x.ppt")).toMatchObject({ status: "unsupported", text: null });
    expect(await extractDocument(new TextEncoder().encode("  "), "text/plain", "x.txt")).toMatchObject({ status: "empty", text: null });
    expect(await extractDocument(new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf")).toMatchObject({ status: "failed", text: null });
  });
});
