// La normalisation TS (aperçu d'import) doit donner exactement le même résultat que SQL.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, type Db } from "../db/harness";
import { normCompanyName, normDomain, normEmail, normLinkedin, normPersonName, isFreeEmailDomain, companyKeyDomain } from "@/lib/crm/normalize";

let db: Db;
beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => db.close());

const domains = ["https://www.Acme.com/", "http://acme.com/contact?x=1#top", "WWW2.acme.co.uk", "blog.acme.com", "acme", "", "  user@acme.io  ", "acme.com:8080/path", "Acme.com."];
const emails = ["  Paul@Acme.com ", "LEA@gmail.com", ""];
const linkedins = ["https://fr.linkedin.com/in/paul-martin/", "linkedin.com/in/paul-martin?utm_source=x", "https://www.linkedin.com/company/acme/", "m.linkedin.com/in/Zoé", ""];
const names = ["Acme SAS", "ACME", "Société Générale", "L'Oréal Groupe SA", "Les Échos & Co", "The Agency Ltd", "Café   Crème", "SA SAS SARL Beta"];
const people: [string, string][] = [["Paul", "Martin"], ["Léa", "Dürand"], ["  Jean-Pierre", "O'Neil "], ["", "Zoé"]];

describe("normalisation TS = SQL", () => {
  test.each(domains)("domaine %j", async (v) => {
    const r = await db.one<{ v: string | null }>(`select public.norm_domain($1) as v`, [v]);
    expect(normDomain(v)).toBe(r.v);
  });
  test.each(emails)("email %j", async (v) => {
    const r = await db.one<{ v: string | null }>(`select public.norm_email($1) as v`, [v]);
    expect(normEmail(v)).toBe(r.v);
  });
  test.each(linkedins)("linkedin %j", async (v) => {
    const r = await db.one<{ v: string | null }>(`select public.norm_linkedin($1) as v`, [v]);
    expect(normLinkedin(v)).toBe(r.v);
  });
  test.each(names)("entreprise %j", async (v) => {
    const r = await db.one<{ v: string | null }>(`select public.norm_company_name($1) as v`, [v]);
    expect(normCompanyName(v)).toBe(r.v);
  });
  test.each(people)("personne %j %j", async (f, l) => {
    const r = await db.one<{ v: string | null }>(`select public.norm_person_name($1, $2) as v`, [f, l]);
    expect(normPersonName(f, l)).toBe(r.v);
  });
});

describe("règles de domaine", () => {
  test("les messageries grand public ne sont pas des domaines d'entreprise", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    expect(isFreeEmailDomain("outlook.fr")).toBe(true);
    expect(companyKeyDomain(null, "jean@gmail.com")).toBeNull();
    expect(companyKeyDomain(null, "jean@acme.com")).toBe("acme.com");
    expect(companyKeyDomain("https://www.acme.com", "jean@gmail.com")).toBe("acme.com");
  });
  test("un sous-domaine reste distinct", () => {
    expect(normDomain("blog.acme.com")).not.toBe(normDomain("acme.com"));
  });
});
