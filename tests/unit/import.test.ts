import { describe, expect, test } from "vitest";
import { buildRows, groupRows, guessMapping } from "@/lib/crm/import";

const headers = ["Entreprise", "Site web", "Prénom", "Nom", "Email", "Téléphone", "LinkedIn", "Source"];
const records = [
  { Entreprise: "Acme", "Site web": "acme.com", Prénom: "Paul", Nom: "Martin", Email: "paul@acme.com", Téléphone: "", LinkedIn: "", Source: "LinkedIn" },
  { Entreprise: "ACME SAS", "Site web": "", Prénom: "Léa", Nom: "Durand", Email: "lea@acme.com", Téléphone: "", LinkedIn: "", Source: "" },
  { Entreprise: "Acme", "Site web": "https://www.acme.com", Prénom: "Paul", Nom: "Martin", Email: "PAUL@acme.com", Téléphone: "0601", LinkedIn: "", Source: "" },
  { Entreprise: "Boulangerie Dupont", "Site web": "", Prénom: "Jean", Nom: "Dupont", Email: "jean@gmail.com", Téléphone: "", LinkedIn: "", Source: "" },
  { Entreprise: "Studio Graphik", "Site web": "", Prénom: "Marie", Nom: "Leroy", Email: "marie@gmail.com", Téléphone: "", LinkedIn: "", Source: "" },
  { Entreprise: "", "Site web": "", Prénom: "Sans", Nom: "Entreprise", Email: "x@y.fr", Téléphone: "", LinkedIn: "", Source: "" },
];

describe("import CSV", () => {
  test("correspondance automatique des colonnes", () => {
    const m = guessMapping(headers);
    expect(m).toMatchObject({ company: "Entreprise", website: "Site web", first_name: "Prénom", last_name: "Nom", email: "Email", phone: "Téléphone", linkedin_url: "LinkedIn", source: "Source" });
  });

  test("regroupe les personnes d'une même entreprise, dédoublonne dans le fichier, ne regroupe pas via Gmail", async () => {
    const rows = await buildRows(records, guessMapping(headers));
    expect(rows.find((r) => r.line === 7)?.error).toBe("Nom d'entreprise manquant");
    const groups = groupRows(rows, true);
    expect(groups).toHaveLength(3);
    const acme = groups.find((g) => g.key === "d:acme.com")!;
    expect(acme.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(acme.people).toHaveLength(2);
    expect(acme.inFileDuplicates).toBe(1);
    expect(acme.people.find((p) => p.first_name === "Paul")?.phone).toBe("0601");
    expect(groups.filter((g) => g.key.startsWith("n:"))).toHaveLength(2);
  });

  test("l'empreinte d'une ligne est stable d'un import à l'autre", async () => {
    const a = await buildRows(records, guessMapping(headers));
    const b = await buildRows(records, guessMapping(headers));
    expect(a.map((r) => r.hash)).toEqual(b.map((r) => r.hash));
    expect(a[0].hash).toBe(a[2].hash); // même personne, saisie différente
  });
});
