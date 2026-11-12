// Corbeille, lot 2 : Finance — disparition partout (totaux compris), restauration à l'identique, numéro réservé,
// règlements qui suivent leur facture, parent encore à la corbeille, purge à 30 jours (date simulée).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigrations, createDb, type Db } from "./harness";

const SERVER_KEY = "test-server-key-0123456789abcdef0123456789";
let db: Db;
let co: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

const company = async (name: string) => (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name }, p_people: [] })).id!;
const revenue = async (data: Record<string, unknown>) =>
  (await db.rpc<{ id: string }>("finance_add_revenue", { p_data: { company_id: co, label: "[TEST] Prestation", ...data } })).id;
const invoice = async (data: Record<string, unknown>) =>
  (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, issue_date: today(), amount_ht: 1000, vat_amount: 200, ...data } })).id;
const pay = async (inv: string, amount: number) =>
  (await db.rpc<{ id: string }>("finance_record_payment", { p_invoice: inv, p_paid_on: today(), p_amount: amount })).id;
const put = (kind: string, id: string) => db.rpc<{ trash_id: string; already: boolean; summary: Record<string, number> }>("trash_put", { p_kind: kind, p_id: id });
const restore = (t: string, withParent = false) => db.rpc<Record<string, unknown>>("trash_restore", { p_trash: t, p_with_parent: withParent });
const rows = async (sql: string, params?: unknown[]) => (await db.query<Record<string, unknown>>(sql, params)).rows;
/** Tout ce que Finance affiche : factures, totaux par revenu, mouvements de trésorerie. */
const financeState = async () => ({
  invoices: await rows(`select id, status, paid_net::text, balance::text from finance_invoice_overview order by id`),
  missions: await rows(`select * from finance_mission_overview order by id`),
  cash: await rows(`select * from finance_cash_movements order by 1, 2`),
  payments: await rows(`select id from finance_payments order by id`),
});
/** Lignes brutes (droits d'administration) : la restauration ne doit rien réécrire. */
const raw = async (table: string, ids: string[]) => {
  await db.exec("reset role");
  const r = await rows(`select to_jsonb(t) j from ${table} t where id = any($1) order by id`, [ids]);
  await db.as("owner");
  return r;
};

beforeEach(async () => {
  db = await createDb();
  await db.exec(`reset role; update appt_settings set server_key_hash = '${createHash("sha256").update(SERVER_KEY).digest("hex")}'`);
  await db.as("owner");
  co = await company("[TEST] Studio");
});

describe("Facture réglée", () => {
  test("mise à la corbeille : disparaît des listes et des totaux avec ses règlements ; restaurée à l'identique", async () => {
    const inv = await invoice({ reference: "F-2026-001" });
    const p1 = await pay(inv, 700);
    const p2 = await pay(inv, 500);
    const before = await financeState();
    const rawBefore = [await raw("finance_invoices", [inv]), await raw("finance_payments", [p1, p2])];
    expect(before.invoices.find((i) => i.id === inv)).toMatchObject({ status: "payee", paid_net: "1200.00" });

    const preview = await db.rpc<{ label: string; warnings: string[]; summary: Record<string, number> }>("trash_preview", { p_kind: "finance_invoice", p_id: inv });
    expect(preview.label).toContain("F-2026-001");
    expect(preview.summary).toEqual({ finance_payments: 2 });
    expect(preview.warnings.join(" ")).toMatch(/réglée.*1200,00 €/);
    expect(preview.warnings.join(" ")).toMatch(/reste réservé/);

    const t = await put("finance_invoice", inv);
    expect(t.summary).toEqual({ finance_payments: 2 });
    const during = await financeState();
    expect(during.invoices.find((i) => i.id === inv)).toBeUndefined();
    expect(during.payments).toEqual([]);
    expect(during.cash.length).toBe(before.cash.length - 2);
    // même par identifiant direct
    expect(await rows(`select id from finance_invoices where id = $1`, [inv])).toEqual([]);
    expect(await rows(`select id from finance_payments where invoice_id = $1`, [inv])).toEqual([]);
    // et sans pouvoir la modifier ni y ajouter un règlement
    await db.query(`update finance_invoices set note = 'x' where id = $1`, [inv]);
    await expect(pay(inv, 10)).rejects.toThrow(/introuvable/);

    expect(await restore(t.trash_id)).toMatchObject({ restored: true });
    expect(await financeState()).toEqual(before);
    expect([await raw("finance_invoices", [inv]), await raw("finance_payments", [p1, p2])]).toEqual(rawBefore);
    expect(await rows(`select * from trash_items`)).toEqual([]);
  });

  test("le numéro reste réservé pendant que la facture est à la corbeille, et elle le retrouve à la restauration", async () => {
    const inv = await invoice({ reference: "F-77" });
    const t = await put("finance_invoice", inv);
    await expect(invoice({ reference: "f-77" })).rejects.toThrow(/déjà enregistrée/);
    const other = await invoice({ reference: "F-78" });
    await expect(db.rpc("finance_update_invoice", { p_id: other, p_data: { reference: "F-77" } })).rejects.toThrow(/déjà enregistrée/);
    await restore(t.trash_id);
    expect((await db.one<{ reference: string }>(`select reference from finance_invoices where id = $1`, [inv])).reference).toBe("F-77");
  });

  test("facture avec règlement partiel : le reste à encaisser et l'encaissé reviennent à l'identique", async () => {
    const inv = await invoice({ reference: "F-3" });
    await pay(inv, 400);
    const before = await financeState();
    expect(before.invoices.find((i) => i.id === inv)).toMatchObject({ status: "partielle", paid_net: "400.00", balance: "800.00" });
    const preview = await db.rpc<{ warnings: string[] }>("trash_preview", { p_kind: "finance_invoice", p_id: inv });
    expect(preview.warnings.join(" ")).toMatch(/Règlement partiel : 400,00 € encaissés sur 1200,00 €/);
    const t = await put("finance_invoice", inv);
    expect((await financeState()).invoices).toEqual([]);
    await restore(t.trash_id);
    expect(await financeState()).toEqual(before);
  });

  test("double clic : la seconde mise à la corbeille renvoie le même élément", async () => {
    const inv = await invoice({});
    const a = await put("finance_invoice", inv);
    const b = await put("finance_invoice", inv);
    expect(b).toMatchObject({ trash_id: a.trash_id, already: true });
    expect((await rows(`select id from trash_items`)).length).toBe(1);
    await restore(a.trash_id);
    expect(await restore(a.trash_id)).toEqual({ restored: false, already: true });
  });

  test("un avoir suit sa facture", async () => {
    const inv = await invoice({ reference: "F-9" });
    const av = (await db.rpc<{ id: string }>("finance_record_credit_note", { p_invoice: inv, p_data: { issue_date: today(), amount_ht: 100, vat_amount: 20 } })).id;
    const t = await put("finance_invoice", inv);
    expect(t.summary).toEqual({ finance_invoices: 1 });
    expect(await rows(`select id from finance_invoices where id = $1`, [av])).toEqual([]);
    await restore(t.trash_id);
    expect((await rows(`select id from finance_invoices where id = $1`, [av])).length).toBe(1);
  });
});

describe("Règlement seul, parent encore à la corbeille", () => {
  test("règlement à la corbeille : le reste à encaisser remonte ; restauré, il redescend", async () => {
    const inv = await invoice({});
    const p = await pay(inv, 1200);
    const t = await put("finance_payment", p);
    expect((await db.one(`select status, balance::text from finance_invoice_overview where id = $1`, [inv]))).toEqual({ status: "a_encaisser", balance: "1200.00" });
    await restore(t.trash_id);
    expect((await db.one(`select status, balance::text from finance_invoice_overview where id = $1`, [inv]))).toEqual({ status: "payee", balance: "0.00" });
  });

  test("restaurer un règlement dont la facture est à la corbeille propose de restaurer la facture", async () => {
    const inv = await invoice({ reference: "F-10" });
    const p = await pay(inv, 300);
    const tp = await put("finance_payment", p);
    const ti = await put("finance_invoice", inv);
    const r = await restore(tp.trash_id);
    expect(r).toMatchObject({ restored: false, needs_parent: { trash_id: ti.trash_id, kind: "finance_invoice" } });
    expect(await rows(`select id from finance_payments`)).toEqual([]);
    expect(await restore(tp.trash_id, true)).toMatchObject({ restored: true });
    expect((await rows(`select id from finance_invoices where id = $1`, [inv])).length).toBe(1);
    expect((await rows(`select id from finance_payments where id = $1`, [p])).length).toBe(1);
    expect(await rows(`select * from trash_items`)).toEqual([]);
  });
});

describe("Revenu", () => {
  test("un revenu part avec ses factures et leurs règlements ; la vente liée reste", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 3000, date: today() });
    const inv = await invoice({ mission_id: m, reference: "F-11" });
    await pay(inv, 500);
    const before = await financeState();
    const t = await put("finance_mission", m);
    expect(t.summary).toEqual({ finance_invoices: 1, finance_payments: 1 });
    const during = await financeState();
    expect(during.missions.find((x) => x.id === m)).toBeUndefined();
    expect(during.invoices).toEqual([]);
    await restore(t.trash_id);
    expect(await financeState()).toEqual(before);
  });
});

describe("Sécurité", () => {
  test("un autre compte ne voit rien et ne peut ni supprimer ni restaurer", async () => {
    const inv = await invoice({});
    const t = await put("finance_invoice", inv);
    await db.as("stranger");
    await expect(restore(t.trash_id)).rejects.toThrow(/Accès refusé/);
    await expect(put("finance_invoice", inv)).rejects.toThrow(/Accès refusé/);
    await db.as("owner");
    expect((await rows(`select id from trash_items`)).length).toBe(1);
  });

  test("Claude passe par la corbeille, avec les mêmes règles", async () => {
    const inv = await invoice({});
    await db.as("claude");
    const t = await put("finance_invoice", inv);
    expect(await rows(`select id from finance_invoices where id = $1`, [inv])).toEqual([]);
    expect((await db.one<{ actor: string }>(`select actor from trash_items where id = $1`, [t.trash_id])).actor).toBe("claude");
    await expect(db.rpc("trash_purge", { p_trash: t.trash_id })).rejects.toThrow(/Corbeille de l'application/);
  });

  test("échec en cours d'opération : rien n'est mis à la corbeille (tout ou rien)", async () => {
    const inv = await invoice({});
    await pay(inv, 100);
    await db.exec(`reset role;
      create function public.zz_fail() returns trigger language plpgsql as $$ begin if new.row_table = 'finance_payments' then raise exception 'panne simulée'; end if; return new; end $$;
      create trigger zz_fail before insert on public.trash_rows for each row execute function public.zz_fail();`);
    await db.as("owner");
    await expect(put("finance_invoice", inv)).rejects.toThrow(/panne simulée/);
    expect(await rows(`select * from trash_items`)).toEqual([]);
    expect((await rows(`select id from finance_invoices where id = $1`, [inv])).length).toBe(1);
  });
});

describe("Purge", () => {
  test("après 30 jours (date simulée) : facture et règlements supprimés définitivement ; avant, rien", async () => {
    const inv = await invoice({ reference: "F-12" });
    const p = await pay(inv, 1200);
    const t = await put("finance_invoice", inv);
    await db.as("anon");
    expect(await db.rpc("trash_purge_due", { p_server_key: SERVER_KEY })).toMatchObject({ purged: 0 });
    await db.exec(`reset role; update trash_items set purge_after = now() - interval '1 minute' where id = '${t.trash_id}'`);
    await db.as("anon");
    expect(await db.rpc("trash_purge_due", { p_server_key: SERVER_KEY })).toMatchObject({ purged: 1, failed: 0 });
    await db.exec("reset role");
    expect(await rows(`select id from finance_invoices where id = $1`, [inv])).toEqual([]);
    expect(await rows(`select id from finance_payments where id = $1`, [p])).toEqual([]);
    expect(await rows(`select * from trash_items`)).toEqual([]);
    expect(await rows(`select * from trash_rows`)).toEqual([]);
    // le numéro est libéré une fois la facture définitivement supprimée
    await db.as("owner");
    await invoice({ reference: "F-12" });
  });

  test("« Supprimer définitivement » depuis la Corbeille", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 1000, date: today() });
    const inv = await invoice({ mission_id: m });
    const t = await put("finance_mission", m);
    expect(await db.rpc("trash_purge", { p_trash: t.trash_id })).toEqual({ purged: true, files: [] });
    await db.exec("reset role");
    expect(await rows(`select id from finance_missions where id = $1`, [m])).toEqual([]);
    expect(await rows(`select id from finance_invoices where id = $1`, [inv])).toEqual([]);
  });
});

describe("Données créées avant la corbeille", () => {
  test("mise à niveau : les factures existantes restent visibles et se suppriment / restaurent normalement", async () => {
    const old = await createDb({ upTo: "20261115000900" });
    db = old;
    co = await company("[TEST] Ancien client");
    const inv = await invoice({ reference: "OLD-1" });
    await pay(inv, 1200);
    const before = await financeState();
    await applyMigrations(old, { after: "20261115000900" });
    await db.as("owner");
    expect(await financeState()).toEqual(before);
    const t = await put("finance_invoice", inv);
    expect((await financeState()).invoices).toEqual([]);
    await restore(t.trash_id);
    expect(await financeState()).toEqual(before);
  });
});
