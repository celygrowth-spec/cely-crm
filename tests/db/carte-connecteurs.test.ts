// Carte des connecteurs : activité des clients MCP (écrite par le jeton du client lui-même) et outils déclarés,
// réservés au propriétaire dans l'application. Ni le portail (anon), ni un autre compte, ni Claude n'y accèdent.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const asClient = async (clientId: string) => {
  await db.exec(`reset role;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: "00000000-0000-0000-0000-000000000001", role: "authenticated", client_id: clientId })]);
  await db.exec(`set role authenticated;`);
};

describe("mcp_clients", () => {
  test("chaque client MCP est enregistré sous son propre client_id, lu dans le jeton", async () => {
    await asClient("client-claude-ai");
    await db.rpc("touch_mcp_client", { p_name: "claude-ai", p_version: "0.1.0" });
    await asClient("client-claude-code");
    await db.rpc("touch_mcp_client", { p_name: "Claude Code <script>", p_version: null });
    await db.rpc("touch_mcp_client", { p_name: null, p_version: null }); // < 30 s : ignoré, nom conservé
    await db.as("owner");
    const rows = (await db.query<{ client_id: string; client_name: string; calls: number }>(`select client_id, client_name, calls::int from mcp_clients order by client_id`)).rows;
    expect(rows).toEqual([
      { client_id: "client-claude-ai", client_name: "claude-ai", calls: 1 },
      { client_id: "client-claude-code", client_name: "Claude Code script", calls: 1 },
    ]);
  });

  test("sans client_id (session de l'application) ou hors propriétaire : rien n'est écrit", async () => {
    await db.as("owner");
    await db.rpc("touch_mcp_client", { p_name: "faux", p_version: null });
    await db.as("stranger");
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: "00000000-0000-0000-0000-000000000002", role: "authenticated", client_id: "intrus" })]);
    await db.rpc("touch_mcp_client", { p_name: "intrus", p_version: null });
    await db.as("owner");
    expect((await db.query(`select * from mcp_clients`)).rows).toEqual([]);
  });

  test("lecture réservée au propriétaire ; écriture directe refusée à tous", async () => {
    await asClient("client-a");
    await db.rpc("touch_mcp_client", { p_name: null, p_version: null });
    await expect(db.query(`select * from mcp_clients`)).resolves.toMatchObject({ rows: [] }); // Claude ne lit pas
    await expect(db.query(`insert into mcp_clients (client_id) values ('x')`)).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from mcp_clients`)).rows).toEqual([]);
    await db.as("anon");
    await expect(db.query(`select * from mcp_clients`)).rejects.toThrow(/permission denied/);
    await db.as("owner");
    expect((await db.query(`select client_id from mcp_clients`)).rows).toEqual([{ client_id: "client-a" }]);
    await expect(db.query(`update mcp_clients set calls = 0`)).rejects.toThrow(/permission denied/);
  });
});

describe("connector_map_tools", () => {
  test("déclarer Tiime sous Make (lui-même déclaré), sans doublon, puis supprimer en cascade", async () => {
    await db.as("owner");
    const make = await db.one<{ id: string }>(`insert into connector_map_tools (parent_key, name) values ('mcp:client-claude-ai', 'Make') returning id`);
    await db.query(`insert into connector_map_tools (parent_tool, name) values ($1, 'Tiime')`, [make.id]);
    // double clic : même parent, même nom (casse ignorée) → refusé par l'index unique
    await expect(db.query(`insert into connector_map_tools (parent_tool, name) values ($1, 'tiime')`, [make.id])).rejects.toThrow(/duplicate key/);
    // même nom sous un autre parent : accepté
    await db.query(`insert into connector_map_tools (parent_key, name) values ('core', 'Tiime')`);
    expect(Number((await db.one<{ n: number }>(`select count(*) n from connector_map_tools`)).n)).toBe(3);
    await db.query(`delete from connector_map_tools where id = $1`, [make.id]);
    expect((await db.query(`select name, parent_key from connector_map_tools`)).rows).toEqual([{ name: "Tiime", parent_key: "core" }]);
  });

  test("parent obligatoire et unique, format contrôlé, nom nettoyé", async () => {
    await db.as("owner");
    await expect(db.query(`insert into connector_map_tools (name) values ('Seul')`)).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into connector_map_tools (parent_key, name) values ('n''importe quoi', 'X')`)).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into connector_map_tools (parent_key, name) values ('core', '  X ')`)).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into connector_map_tools (parent_key, name) values ('core', '')`)).rejects.toThrow(/check constraint/);
  });

  test("autre compte, Claude et portail : ni lecture, ni écriture, ni suppression", async () => {
    await db.as("owner");
    await db.query(`insert into connector_map_tools (parent_key, name) values ('core', 'Make')`);
    await db.as("stranger");
    expect((await db.query(`select * from connector_map_tools`)).rows).toEqual([]);
    await expect(db.query(`insert into connector_map_tools (parent_key, name) values ('core', 'Intrus')`)).rejects.toThrow(/row-level security/);
    await expect(db.query(`delete from connector_map_tools`)).resolves.toMatchObject({ affectedRows: 0 });
    await db.as("claude");
    expect((await db.query(`select * from connector_map_tools`)).rows).toEqual([]);
    await expect(db.query(`insert into connector_map_tools (parent_key, name) values ('core', 'Par Claude')`)).rejects.toThrow(/row-level security/);
    await db.as("anon");
    await expect(db.query(`select * from connector_map_tools`)).rejects.toThrow(/permission denied/);
    await db.as("owner");
    expect((await db.query(`select name from connector_map_tools`)).rows).toEqual([{ name: "Make" }]);
  });
});
