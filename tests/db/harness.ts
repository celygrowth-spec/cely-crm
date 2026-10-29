// Base Postgres embarquée (PGlite) qui reproduit l'essentiel de l'environnement
// Supabase : rôles anon/authenticated, schéma auth et fonctions auth.uid()/auth.jwt().
// Les migrations réelles de supabase/migrations sont appliquées telles quelles.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

export const OWNER = "00000000-0000-0000-0000-000000000001";
export const STRANGER = "00000000-0000-0000-0000-000000000002";

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
grant usage on schema auth to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated;
`;

export type Db = PGlite & {
  as: (who: "owner" | "stranger" | "anon" | "claude") => Promise<void>;
  rpc: <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<T>;
  one: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T>;
};

export async function createDb(): Promise<Db> {
  const pg = new PGlite({ extensions: { pg_trgm, unaccent } });
  await pg.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  await pg.exec(`grant usage on schema extensions to anon, authenticated;`);
  await pg.query(`insert into auth.users (id, email) values ($1, 'moi@celygrowth.com'), ($2, 'autre@example.com')`, [
    OWNER,
    STRANGER,
  ]);
  await pg.query(`insert into public.app_owner (user_id) values ($1)`, [OWNER]);

  const db = pg as Db;
  db.as = async (who) => {
    await pg.exec(`reset role;`);
    const claims =
      who === "anon"
        ? { role: "anon" }
        : who === "stranger"
          ? { sub: STRANGER, role: "authenticated" }
          : who === "claude"
            ? { sub: OWNER, role: "authenticated", client_id: "claude-test-client" }
            : { sub: OWNER, role: "authenticated" };
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    await pg.exec(`set role ${who === "anon" ? "anon" : "authenticated"};`);
  };
  db.rpc = async (fn, args) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    const res = await pg.query<{ r: unknown }>(sql, keys.map((k) => args[k]));
    return res.rows[0]?.r as never;
  };
  db.one = async (sql, params) => {
    const res = await pg.query(sql, params);
    return res.rows[0] as never;
  };
  await db.as("owner");
  return db;
}
