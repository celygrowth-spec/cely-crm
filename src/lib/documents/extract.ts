import "server-only";
// K10 : lecture du contenu des documents (proposition, contrat, brief). PDF (texte intégré), Word (.docx), texte.
// Un PDF scanné (images seulement) ou un ancien .doc ne sont pas lus : le statut le dit, rien n'est inventé.
import { unzipSync, strFromU8 } from "fflate";

export type Extracted = { status: "ok" | "empty" | "unsupported" | "failed"; text: string | null; error: string | null };

const MAX = 200_000;
const clean = (t: string) => t.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX);

/** Texte d'un .docx : paragraphes de word/document.xml (les tableaux et listes deviennent des lignes). */
export function docxText(data: Uint8Array): string {
  const files = unzipSync(data, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("document Word illisible");
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export async function pdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export async function extractDocument(data: Uint8Array, mime: string, name: string): Promise<Extracted> {
  try {
    let raw: string;
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) raw = await pdfText(data);
    else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name)) raw = docxText(data);
    else if (/^text\//.test(mime) || /\.(txt|md|csv)$/i.test(name)) raw = new TextDecoder().decode(data);
    else return { status: "unsupported", text: null, error: "Format non lu automatiquement (PDF, Word .docx ou texte seulement)" };
    const text = clean(raw);
    if (text.length < 20) return { status: "empty", text: null, error: "Aucun texte lisible (document scanné ?)" };
    return { status: "ok", text, error: null };
  } catch (e) {
    return { status: "failed", text: null, error: `Lecture impossible : ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
  }
}
