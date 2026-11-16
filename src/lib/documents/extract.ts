import "server-only";
// K10 : lecture du contenu des documents (proposition, contrat, brief). PDF (texte intégré), Word (.docx), texte.
// Un PDF scanné (images seulement) ou un ancien .doc ne sont pas lus : le statut le dit, rien n'est inventé.
import { unzipSync, strFromU8 } from "fflate";

export type Extracted = { status: "ok" | "empty" | "unsupported" | "failed"; text: string | null; error: string | null; truncated?: boolean };

const MAX = 200_000;
const clean = (t: string) => t.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const PDF = (mime: string, name: string) => mime === "application/pdf" || /\.pdf$/i.test(name);
const DOCX = (mime: string, name: string) => mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name);
const TEXT = (mime: string, name: string) => /^text\//.test(mime) || /\.(txt|md|csv)$/i.test(name);

/** Formats dont le texte est extrait : PDF, Word .docx, texte. Les autres (images, archives…) ne sont pas lus. */
export const isExtractable = (mime: string, name: string) => PDF(mime, name) || DOCX(mime, name) || TEXT(mime, name);

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

/** Texte d'un document, limité à `max` caractères ; `truncated` signale un texte coupé. */
export async function extractDocument(data: Uint8Array, mime: string, name: string, max = MAX): Promise<Extracted> {
  try {
    let raw: string;
    if (PDF(mime, name)) raw = await pdfText(data);
    else if (DOCX(mime, name)) raw = docxText(data);
    else if (TEXT(mime, name)) raw = new TextDecoder().decode(data);
    else return { status: "unsupported", text: null, error: "Format non lu automatiquement (PDF, Word .docx ou texte seulement)" };
    const full = clean(raw);
    if (full.length < 20) return { status: "empty", text: null, error: "Aucun texte lisible (document scanné ?)" };
    return { status: "ok", text: full.slice(0, max), error: null, truncated: full.length > max };
  } catch (e) {
    return { status: "failed", text: null, error: `Lecture impossible : ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
  }
}
