import { expect, test } from "vitest";
import { planCompletion, type PersonDraft } from "@/lib/crm/complete-existing";
import type { Person } from "@/lib/crm/types";

const person = (p: Partial<Person>): Person => ({ id: "p1", company_id: "c", first_name: null, last_name: null, title: null, email: null, phone: null, linkedin_url: null, is_primary: true, created_at: "", ...p });
const draft = (p: Partial<PersonDraft>): PersonDraft => ({ first_name: "", last_name: "", title: "", email: "", phone: "", linkedin_url: "", ...p });

test("ne remplit que les champs vides de la fiche et ajoute les tags absents", () => {
  const plan = planCompletion(
    { website: "acme.fr", description: null, source_id: null, tags: ["saas"] },
    [],
    { website: "autre.fr", description: "Besoin SEO", source_id: "s1", tags: ["SaaS", "b2b"] },
    [],
  );
  expect(plan.patch).toEqual({ description: "Besoin SEO", source_id: "s1", tags: ["saas", "b2b"] });
  expect(plan.summary).toEqual(["description", "source", "1 tag"]);
});

test("personne reconnue : seuls ses champs vides sont complétés ; personne inconnue : ajoutée", () => {
  const plan = planCompletion(
    { website: null, description: null, source_id: null, tags: [] },
    [person({ first_name: "Jean", last_name: "Dupont", email: "jean@acme.fr", title: "CEO" })],
    { website: "", description: "", source_id: "", tags: [] },
    [draft({ email: "JEAN@acme.fr", title: "CTO", phone: "0601" }), draft({ first_name: "Marie", email: "marie@acme.fr" }), draft({})],
  );
  expect(plan.patch).toEqual({});
  expect(plan.fill).toEqual([{ id: "p1", fields: ["phone"], person: { first_name: "Jean", last_name: "Dupont", title: "CEO", email: "jean@acme.fr", phone: "0601", linkedin_url: "" } }]);
  expect(plan.add.map((p) => p.email)).toEqual(["marie@acme.fr"]);
});

test("rien à ajouter quand la fiche contient déjà tout", () => {
  const plan = planCompletion({ website: "a.fr", description: "x", source_id: "s", tags: ["t"] }, [person({ email: "a@a.fr" })], { website: "a.fr", description: "y", source_id: "s2", tags: ["T"] }, [draft({ email: "a@a.fr" })]);
  expect(plan).toEqual({ patch: {}, add: [], fill: [], summary: [] });
});
