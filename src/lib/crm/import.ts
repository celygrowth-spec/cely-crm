// Préparation d'un import CSV côté navigateur : correspondance des colonnes, regroupement
// des personnes d'une même entreprise, empreinte des lignes. Les contrôles définitifs
// (doublons, validation) sont refaits en base par import_check / import_commit.
import { companyKeyDomain, normCompanyName, normEmail, normLinkedin, normPersonName } from "./normalize";

export const IMPORT_FIELDS = [
  { key: "company", label: "Entreprise", required: true, guesses: ["entreprise", "company", "société", "societe", "organisation", "organization", "account", "compte"] },
  { key: "website", label: "Site web", guesses: ["site", "website", "domaine", "domain", "url", "web"] },
  { key: "first_name", label: "Prénom", guesses: ["prénom", "prenom", "first name", "firstname", "first_name", "given name"] },
  { key: "last_name", label: "Nom", guesses: ["nom", "last name", "lastname", "last_name", "surname", "family name", "nom de famille"] },
  { key: "full_name", label: "Nom complet", guesses: ["nom complet", "full name", "fullname", "name", "contact"] },
  { key: "title", label: "Poste", guesses: ["poste", "title", "job title", "fonction", "position", "rôle", "role"] },
  { key: "email", label: "Email", guesses: ["email", "e-mail", "mail", "courriel"] },
  { key: "phone", label: "Téléphone", guesses: ["téléphone", "telephone", "phone", "tel", "mobile", "portable"] },
  { key: "linkedin_url", label: "LinkedIn", guesses: ["linkedin", "profil linkedin", "linkedin url", "linkedin_url"] },
  { key: "source", label: "Source", guesses: ["source", "origine", "lead source"] },
  { key: "description", label: "Description", guesses: ["description", "besoin", "notes", "note", "commentaire"] },
] as const;

export type FieldKey = (typeof IMPORT_FIELDS)[number]["key"];
export type Mapping = Partial<Record<FieldKey, string>>;

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<string>();
  for (const f of IMPORT_FIELDS) {
    const h =
      headers.find((x) => !used.has(x) && (f.guesses as readonly string[]).includes(x.trim().toLowerCase())) ??
      headers.find((x) => !used.has(x) && (f.guesses as readonly string[]).some((g) => x.trim().toLowerCase().includes(g)));
    if (h) {
      m[f.key] = h;
      used.add(h);
    }
  }
  return m;
}

export type ImportPerson = { first_name: string | null; last_name: string | null; title: string | null; email: string | null; phone: string | null; linkedin_url: string | null };

export type ImportRow = {
  line: number; // numéro de ligne dans le fichier (1 = en-tête)
  hash: string;
  company: string;
  website: string | null;
  source: string | null;
  description: string | null;
  person: ImportPerson | null;
  error: string | null;
};

export type ImportGroup = {
  key: string;
  rows: ImportRow[];
  company: { name: string; website: string | null; source: string | null; description: string | null };
  people: ImportPerson[];
  inFileDuplicates: number; // personnes en double dans le fichier
};

const clean = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildRows(records: Record<string, string>[], mapping: Mapping): Promise<ImportRow[]> {
  const get = (r: Record<string, string>, k: FieldKey) => (mapping[k] ? clean(r[mapping[k]!]) : null);
  return Promise.all(
    records.map(async (r, i) => {
      let first = get(r, "first_name");
      let last = get(r, "last_name");
      const full = get(r, "full_name");
      if (!first && !last && full) {
        const parts = full.split(/\s+/);
        first = parts.shift() ?? null;
        last = parts.join(" ") || null;
      }
      const email = get(r, "email");
      const linkedin = get(r, "linkedin_url");
      const person: ImportPerson | null =
        first || last || email || linkedin ? { first_name: first, last_name: last, title: get(r, "title"), email, phone: get(r, "phone"), linkedin_url: linkedin } : null;
      const company = get(r, "company") ?? "";
      const website = get(r, "website");
      let error: string | null = null;
      if (!company) error = "Nom d'entreprise manquant";
      else if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) error = `Email invalide : ${email}`;
      // empreinte des valeurs normalisées : la même ligne importée deux fois est reconnue
      const hash = await sha256(
        JSON.stringify([normCompanyName(company), companyKeyDomain(website, email), normEmail(email), normLinkedin(linkedin), normPersonName(first, last)]),
      );
      return { line: i + 2, hash, company, website, source: get(r, "source"), description: get(r, "description"), person, error };
    }),
  );
}

/** Regroupe les lignes par entreprise : domaine (site ou email pro), sinon nom normalisé. */
export function groupRows(rows: ImportRow[], groupByCompany: boolean): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const r of rows) {
    if (r.error) continue;
    const domain = companyKeyDomain(r.website, r.person?.email);
    const key = groupByCompany ? (domain ? `d:${domain}` : `n:${normCompanyName(r.company) ?? r.company.toLowerCase()}`) : `r:${r.line}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, rows: [], company: { name: r.company, website: r.website, source: r.source, description: r.description }, people: [], inFileDuplicates: 0 };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.company.website ??= r.website;
    g.company.source ??= r.source;
    g.company.description ??= r.description;
    if (r.person) {
      const p = r.person;
      const dup = g.people.find(
        (x) =>
          (p.email && normEmail(x.email) === normEmail(p.email)) ||
          (p.linkedin_url && normLinkedin(x.linkedin_url) === normLinkedin(p.linkedin_url)) ||
          (!p.email && !p.linkedin_url && normPersonName(x.first_name, x.last_name) === normPersonName(p.first_name, p.last_name)),
      );
      if (dup) {
        g.inFileDuplicates++;
        for (const k of Object.keys(p) as (keyof ImportPerson)[]) dup[k] ??= p[k];
      } else g.people.push({ ...p });
    }
  }
  return [...groups.values()];
}
