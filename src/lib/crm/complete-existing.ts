// « Compléter la fiche existante » (création bloquée par un doublon) : ce que la saisie ajoute à la fiche
// existante, sans jamais remplacer une valeur déjà remplie. Fonction pure, appliquée ensuite par les
// actions habituelles (updateCompanyAction, upsertPersonAction, addToListAction, moveCompanyAction).
import type { Company, Person } from "./types";

export type CompanyDraft = { website: string; description: string; source_id: string; tags: string[] };
export type PersonDraft = { first_name: string; last_name: string; title: string; email: string; phone: string; linkedin_url: string };
const PERSON_FIELDS = ["first_name", "last_name", "title", "email", "phone", "linkedin_url"] as const;

export type CompletionPlan = {
  /** champs de la fiche à remplir (uniquement ceux qui étaient vides ; tags : ajout des absents) */
  patch: Partial<Pick<Company, "website" | "description" | "source_id" | "tags">>;
  /** personnes à créer */
  add: PersonDraft[];
  /** personnes existantes reconnues (email, LinkedIn ou prénom + nom) : seulement leurs champs vides */
  fill: { id: string; person: PersonDraft; fields: string[] }[];
  /** résumé lisible de ce qui sera ajouté */
  summary: string[];
};

const blank = (v: string | null | undefined) => !v || !v.trim();
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

function sameperson(p: Person, d: PersonDraft) {
  if (d.email.trim() && norm(p.email) === norm(d.email)) return true;
  if (d.linkedin_url.trim() && norm(p.linkedin_url).replace(/\/+$/, "") === norm(d.linkedin_url).replace(/\/+$/, "")) return true;
  return !!(d.first_name.trim() && d.last_name.trim() && norm(p.first_name) === norm(d.first_name) && norm(p.last_name) === norm(d.last_name));
}

export function planCompletion(existing: Pick<Company, "website" | "description" | "source_id" | "tags">, people: Person[], company: CompanyDraft, drafts: PersonDraft[]): CompletionPlan {
  const patch: CompletionPlan["patch"] = {};
  const summary: string[] = [];
  if (blank(existing.website) && company.website.trim()) { patch.website = company.website.trim(); summary.push("site web"); }
  if (blank(existing.description) && company.description.trim()) { patch.description = company.description.trim(); summary.push("description"); }
  if (!existing.source_id && company.source_id) { patch.source_id = company.source_id; summary.push("source"); }
  const have = new Set((existing.tags ?? []).map(norm));
  const newTags = [...new Set(company.tags.map((t) => t.trim()).filter((t) => t && !have.has(norm(t))))];
  if (newTags.length) { patch.tags = [...(existing.tags ?? []), ...newTags]; summary.push(newTags.length > 1 ? `${newTags.length} tags` : "1 tag"); }

  const add: PersonDraft[] = [];
  const fill: CompletionPlan["fill"] = [];
  for (const d of drafts) {
    if (!PERSON_FIELDS.some((k) => d[k].trim())) continue;
    const match = people.find((p) => sameperson(p, d));
    if (!match) { add.push(d); continue; }
    const fields = PERSON_FIELDS.filter((k) => blank(match[k]) && d[k].trim());
    if (!fields.length) continue;
    const merged = Object.fromEntries(PERSON_FIELDS.map((k) => [k, blank(match[k]) ? d[k].trim() : (match[k] as string)])) as PersonDraft;
    fill.push({ id: match.id, person: merged, fields });
  }
  if (add.length) summary.push(add.length > 1 ? `${add.length} personnes` : "1 personne");
  if (fill.length) summary.push(fill.length > 1 ? `${fill.length} contacts complétés` : "1 contact complété");
  return { patch, add, fill, summary };
}
