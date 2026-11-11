// Audit, lot 9 : pages Finance sans écriture inutile ; échéances d'abonnement qui suivent le contrat (E6).
import { describe, expect, test } from "vitest";
import { createDb } from "./harness";

const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + n * 864e5));

describe("échéances d'abonnement", () => {
  test("rien de dû : aucune écriture ; contrat modifié après génération : les échéances futures suivent", async () => {
    const db = await createDb();
    const sub = (await db.one<{ id: string }>(`insert into finance_subscriptions (label, amount, frequency, start_date, next_due_date, status) values ('Notion', 10, 'mensuel', $1, $1, 'actif') returning id`, [day(5)])).id;
    expect(await db.rpc("finance_generate_occurrences", { p_until: day(2) })).toBe(0);
    expect(await db.rpc("finance_generate_occurrences", { p_until: day(70) })).toBe(3);
    await db.query(`update finance_subscriptions set amount = 12 where id = $1`, [sub]);
    expect((await db.query(`select amount::text a from finance_expenses where subscription_id = $1 order by planned_date`, [sub])).rows).toEqual([{ a: "12.00" }, { a: "12.00" }, { a: "12.00" }]);
    await db.query(`update finance_subscriptions set end_date = $2 where id = $1`, [sub, day(10)]);
    expect((await db.one<{ n: number }>(`select count(*)::int n from finance_expenses where subscription_id = $1`, [sub])).n).toBe(1);
    // déjà généré, le passage suivant n'ajoute rien après la fin
    expect(await db.rpc("finance_generate_occurrences", { p_until: day(70) })).toBe(0);
  });
});
