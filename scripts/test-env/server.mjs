// Environnement de test local : faux Supabase (PostgREST, Auth et Storage réduits) adossé à PGlite et aux VRAIES
// migrations du dépôt (mêmes fonctions, mêmes politiques RLS). Aucune donnée réelle : base en mémoire, recréée à
// chaque lancement, peuplée de données fictives marquées « [TEST] ».
// Usage : node scripts/test-env/server.mjs [port]   (n'écoute que sur 127.0.0.1)
// Comptes contrôlés : OWNER (propriétaire de l'application) et STRANGER (compte connecté sans droit).
// Limites connues (voir docs/environnement-de-test.md) : Storage simulé en mémoire, JWT non signés, PostgREST
// partiel (filtres et relations imbriquées un-à-plusieurs).
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto, { createHash } from "node:crypto";
import { seed } from "./seed.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nm = (p) => join(ROOT, "node_modules", p);
const { PGlite } = await import(nm("@electric-sql/pglite/dist/index.js"));
const { pg_trgm } = await import(nm("@electric-sql/pglite/dist/contrib/pg_trgm.js"));
const { unaccent } = await import(nm("@electric-sql/pglite/dist/contrib/unaccent.js"));
const { btree_gist } = await import(nm("@electric-sql/pglite/dist/contrib/btree_gist.js"));

const PORT = Number(process.argv[2] ?? 54321);
const ANON = "anon-key-local";
const OWNER = "00000000-0000-0000-0000-000000000001";
const STRANGER = "00000000-0000-0000-0000-000000000002";

const pg = new PGlite({ extensions: { pg_trgm, unaccent, btree_gist }, parsers: { 1082: (v) => v } });
await pg.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
grant usage on schema auth to anon, authenticated; grant execute on all functions in schema auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated; grant all on storage.objects to anon, authenticated;`);
const dir = join(ROOT, "supabase", "migrations");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(join(dir, f), "utf8"));
await pg.exec(`grant usage on schema extensions to anon, authenticated;`);
await pg.query(`insert into auth.users values ($1, 'test-owner@example.test'), ($2, 'test-stranger@example.test')`, [OWNER, STRANGER]);
await pg.query(`insert into public.app_owner (user_id) values ($1)`, [OWNER]);
if (process.env.SERVER_KEY) {
  await pg.query(`update appt_settings set server_key_hash = $1`, [createHash("sha256").update(process.env.SERVER_KEY).digest("hex")]);
}
if (process.env.TEST_ENV_EMPTY !== "1") await seed(pg);

const decode = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()); } catch { return null; }
};

async function asRole(auth, fn) {
  const token = (auth ?? "").replace(/^Bearer /, "");
  const claims = token === ANON || !token ? { role: "anon" } : decode(token) ?? { role: "anon" };
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role ${claims.role === "authenticated" ? "authenticated" : "anon"}`);
    return fn(tx);
  });
}

const ident = (s) => '"' + s.replace(/"/g, '""') + '"';
function lit(v) {
  if (v === null) return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function parseSelect(sel) {
  // colonnes simples ; ressources imbriquées ignorées (alias → null, sinon [])
  const cols = [];
  const embeds = [];
  let depth = 0, cur = "";
  for (const ch of (sel ?? "*")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { cols.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) cols.push(cur.trim());
  const plain = [];
  for (const c of cols) {
    if (c.includes("(")) {
      const name = c.split("(")[0];
      const inner = c.slice(c.indexOf("(") + 1, c.lastIndexOf(")"));
      // ressource enfant sans alias (ex. stages(id, name)) : chargée un-à-plusieurs par sa clé étrangère
      // alias:table(...) : ressource parente (plusieurs-à-un), chargée par la clé étrangère de la ligne
      embeds.push(name.includes(":") ? { key: name.split(":")[0], val: null, parent: name.split(":")[1].replace(/!.*/, ""), inner } : { key: name, val: [], table: name.replace(/!.*/, ""), inner });
    } else plain.push(c === "*" ? "*" : ident(c));
  }
  return { cols: plain.length ? plain.join(", ") : "1 as _", embeds };
}
function cond(col, expr) {
  const m = expr.match(/^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s);
  if (!m) return "true";
  const [, not, op, raw] = m;
  let sql;
  const c = ident(col);
  if (op === "is") sql = `${c} is ${raw === "null" ? "null" : raw}`;
  else if (op === "in") sql = `${c} in (${raw.replace(/^\(|\)$/g, "").split(",").map((x) => lit(x.replace(/^"|"$/g, ""))).join(",")})`;
  else if (op === "like" || op === "ilike") sql = `${c}::text ${op} ${lit(raw.replace(/\*/g, "%"))}`;
  else sql = `${c} ${{ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]} ${lit(raw)}`;
  return not ? `not (${sql})` : sql;
}
function where(params) {
  const parts = [];
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (k === "or") {
      const inner = v.replace(/^\(|\)$/g, "").split(/,(?![^(]*\))/).map((p) => {
        const i = p.indexOf(".");
        return cond(p.slice(0, i), p.slice(i + 1));
      });
      parts.push(`(${inner.join(" or ")})`);
    } else parts.push(cond(k, v));
  }
  return parts.length ? ` where ${parts.join(" and ")}` : "";
}
function order(params) {
  const o = params.get("order");
  if (!o) return "";
  return " order by " + o.split(",").map((p) => {
    const [col, ...mods] = p.split(".");
    return `${ident(col)} ${mods.includes("desc") ? "desc" : "asc"}${mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : ""}`;
  }).join(", ");
}


// --- Storage minimal : chaque opération est vérifiée par les politiques RLS réelles de storage.objects ---
const blobs = new Map();
const tokens = new Map();
async function storageCheck(auth, sqlText, params) {
  try {
    await asRole(auth, async (tx) => {
      const r = await tx.query(sqlText, params);
      if (r.affectedRows === 0 && !/^select/i.test(sqlText)) throw new Error("refusé");
      if (/^select/i.test(sqlText) && r.rows.length === 0) throw new Error("refusé");
      throw new Error("__rollback_ok__");
    });
  } catch (e) { return e.message === "__rollback_ok__"; }
  return false;
}
async function handleStorage(req, url, body, raw, send, res) {
  const m = url.pathname.match(/^\/storage\/v1\/object\/(upload\/sign|sign)\/([^/]+)\/(.+)$/);
  const auth = req.headers.authorization;
  if (m && req.method === "POST" && m[1] === "upload/sign") {
    const [, , bucket, path] = m;
    const ok = await storageCheck(auth, "insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, decodeURIComponent(path)]);
    if (!ok) return send(403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
    const token = crypto.randomUUID(); tokens.set(token, { kind: "upload", bucket, path: decodeURIComponent(path) });
    return send(200, { url: `/object/upload/sign/${bucket}/${path}?token=${token}`, token });
  }
  if (m && req.method === "PUT" && m[1] === "upload/sign") {
    const t = tokens.get(url.searchParams.get("token"));
    if (!t || t.kind !== "upload") return send(400, { message: "invalid token" });
    await pg.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [t.bucket, t.path]);
    blobs.set(`${t.bucket}/${t.path}`, { data: raw, type: req.headers["content-type"] });
    tokens.delete(url.searchParams.get("token"));
    return send(200, { Key: `${t.bucket}/${t.path}` }, { "access-control-allow-origin": "*" });
  }
  if (m && req.method === "POST" && m[1] === "sign") {
    const [, , bucket, path] = m;
    const ok = await storageCheck(auth, "select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, decodeURIComponent(path)]);
    if (!ok) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    const token = crypto.randomUUID(); tokens.set(token, { kind: "read", bucket, path: decodeURIComponent(path) });
    return send(200, { signedURL: `/object/sign/${bucket}/${path}?token=${token}` });
  }
  if (m && req.method === "GET" && m[1] === "sign") {
    const t = tokens.get(url.searchParams.get("token"));
    const b = t && blobs.get(`${t.bucket}/${t.path}`);
    if (!b) return send(404, { message: "not found" });
    const headers = { "content-type": b.type || "application/octet-stream" };
    if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${url.searchParams.get("download") || "fichier"}"`;
    res.writeHead(200, headers); return res.end(b.data);
  }
  const d = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/);
  if (d && req.method === "DELETE") {
    const out = [];
    for (const name of body?.prefixes ?? []) {
      const ok = await asRole(auth, (tx) => tx.query("delete from storage.objects where bucket_id = $1 and name = $2 returning name", [d[1], name])).then((r) => r.rows.length > 0, () => false);
      if (ok) { blobs.delete(`${d[1]}/${name}`); out.push({ name }); }
    }
    return send(200, out);
  }
  // téléchargement direct (supabase-js download) : vérifié par les politiques RLS de lecture
  const g = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/);
  if (g && req.method === "GET") {
    const [, bucket, path] = g;
    const ok = await storageCheck(auth, "select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, decodeURIComponent(path)]);
    const b = ok && blobs.get(`${bucket}/${decodeURIComponent(path)}`);
    if (!b) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    res.writeHead(200, { "content-type": b.type || "application/octet-stream" }); return res.end(b.data);
  }
  return send(404, { message: "storage: not implemented" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, GET, POST, DELETE", "access-control-allow-headers": "*" }); return res.end(); }
  let body = null;
  try { body = chunks.length && !url.pathname.includes("/upload/sign/") ? JSON.parse(raw.toString() || "null") : null; } catch { body = null; }
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(data === undefined ? "" : JSON.stringify(data));
  };
  try {
    if (url.pathname === "/auth/v1/user") {
      const claims = decode((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!claims?.sub) return send(401, { message: "invalid" });
      return send(200, { id: claims.sub, email: claims.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    // serveur OAuth simulé : accès accordés à des clients MCP (liste, retrait) ; /debug/grants pour régler l'état
    if (url.pathname === "/debug/grants") { globalThis.GRANTS = body?.grants ?? []; globalThis.GRANTS_MODE = body?.mode ?? "ok"; return send(200, { ok: true }); }
    if (url.pathname === "/auth/v1/user/oauth/grants") {
      const mode = globalThis.GRANTS_MODE ?? "ok";
      if (mode === "down") return send(503, { message: "unavailable" });
      if (mode === "slow") { await new Promise((r) => setTimeout(r, 20000)); }
      globalThis.GRANTS ??= [];
      if (req.method === "DELETE") { globalThis.GRANTS = globalThis.GRANTS.filter((g) => g.client.id !== url.searchParams.get("client_id")); res.writeHead(204); return res.end(); }
      return send(200, globalThis.GRANTS);
    }
    if (url.pathname.startsWith("/auth/v1/")) return send(200, {});
    if (url.pathname.startsWith("/storage/v1/")) return handleStorage(req, url, body, raw, send, res);
    if (url.pathname === "/debug/sql") return send(200, (await pg.query(body.sql, body.params ?? [])).rows);
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const args = body ?? {};
      const keys = Object.keys(args);
      const isSet = (await pg.query(`select bool_or(proretset) s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = $1`, [rpc[1]])).rows[0]?.s;
      if (isSet) {
        const rows = await asRole(req.headers.authorization, (tx) =>
          tx.query(`select * from public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`, keys.map((k) => args[k])));
        return send(200, rows.rows);
      }
      const r = await asRole(req.headers.authorization, (tx) =>
        tx.query(`select public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? (Array.isArray(args[k]) && args[k].length > 0 && args[k].every((x) => typeof x === "string") ? `{${args[k].map((x) => `"${x}"`).join(",")}}` : Array.isArray(args[k]) && args[k].length === 0 && /^p_(check|person_ids)$/.test(k) ? "{}" : JSON.stringify(args[k])) : args[k]))));
      return send(200, r.rows[0]?.r ?? null);
    }
    const tbl = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (tbl) {
      const t = ident(tbl[1]);
      const p = url.searchParams;
      const { cols, embeds } = parseSelect(p.get("select"));
      const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
      const prefer = req.headers.prefer ?? "";
      const out = await asRole(req.headers.authorization, async (tx) => {
        if (req.method === "GET" || req.method === "HEAD") {
          const lim = p.get("limit") ? ` limit ${Number(p.get("limit"))}` : "";
          const off = p.get("offset") ? ` offset ${Number(p.get("offset"))}` : "";
          const rows = (await tx.query(`select ${cols} from public.${t}${where(p)}${order(p)}${lim}${off}`)).rows;
          for (const e of embeds.filter((x) => x.table && /^\w+$/.test(x.table))) {
            const fk = (await tx.query(`select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
              where c.contype = 'f' and c.conrelid = $1::regclass and c.confrelid = $2::regclass limit 1`, [`public.${e.table}`, `public.${t}`]).catch(() => ({ rows: [] }))).rows[0]?.attname;
            if (!fk || !rows.length || !("id" in rows[0])) continue;
            const innerCols = parseSelect(e.inner).cols;
            const kids = (await tx.query(`select ${innerCols}, ${ident(fk)} as __fk from public.${ident(e.table)} where ${ident(fk)} = any($1)`, [rows.map((r) => r.id)])).rows;
            for (const r of rows) r[`__embed_${e.key}`] = kids.filter((k) => k.__fk === r.id).map((k) => { const { __fk: _fk, _: _x, ...rest } = k; void _fk; void _x; return rest; });
          }
          for (const e of embeds.filter((x) => x.parent && /^\w+$/.test(x.parent))) {
            const fk = (await tx.query(`select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
              where c.contype = 'f' and c.conrelid = $1::regclass and c.confrelid = $2::regclass limit 1`, [`public.${t}`, `public.${e.parent}`]).catch(() => ({ rows: [] }))).rows[0]?.attname;
            if (!fk || !rows.length || (!(fk in rows[0]) && !("id" in rows[0]))) continue;
            // clé étrangère non sélectionnée : lue à part (PostgREST la résout sans qu'on la demande)
            const fkOf = new Map();
            if (!(fk in rows[0])) for (const x of (await tx.query(`select id, ${ident(fk)} as v from public.${t} where id = any($1)`, [rows.map((r) => r.id)])).rows) fkOf.set(x.id, x.v);
            const val = (r) => (fk in r ? r[fk] : fkOf.get(r.id));
            const innerCols = parseSelect(e.inner).cols;
            const ids = [...new Set(rows.map(val).filter(Boolean))];
            const parents = ids.length ? (await tx.query(`select ${innerCols}, id as __pk from public.${ident(e.parent)} where id = any($1)`, [ids])).rows : [];
            for (const r of rows) {
              const hit = parents.find((x) => x.__pk === val(r));
              if (hit) { const { __pk: _pk, _: _x, ...rest } = hit; void _pk; void _x; r[`__embed_${e.key}`] = rest; }
            }
          }
          const count = prefer.includes("count=exact") ? (await tx.query(`select count(*)::int n from public.${t}${where(p)}`)).rows[0].n : null;
          return { rows, count };
        }
        if (req.method === "POST") {
          const list = Array.isArray(body) ? body : [body];
          const rows = [];
          for (const row of list) {
            const ks = Object.keys(row);
            const conflict = prefer.includes("merge-duplicates") && p.get("on_conflict")
              ? ` on conflict (${p.get("on_conflict").split(",").map(ident).join(",")}) do update set ${ks.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}` : "";
            const r = await tx.query(`insert into public.${t} (${ks.map(ident).join(",")}) values (${ks.map((_, i) => `$${i + 1}`).join(",")})${conflict} returning ${cols}`,
              ks.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k])));
            rows.push(...r.rows);
          }
          return { rows };
        }
        if (req.method === "PATCH") {
          const ks = Object.keys(body);
          const r = await tx.query(`update public.${t} set ${ks.map((k, i) => `${ident(k)} = $${i + 1}`).join(", ")}${where(p)} returning ${cols}`,
            ks.map((k) => (body[k] !== null && typeof body[k] === "object" ? JSON.stringify(body[k]) : body[k])));
          return { rows: r.rows };
        }
        if (req.method === "DELETE") return { rows: (await tx.query(`delete from public.${t}${where(p)} returning ${cols}`)).rows };
      });
      const rows = out.rows.map((r) => { const x = { ...r }; delete x._; for (const e of embeds) { const k = `__embed_${e.key}`; x[e.key] = k in x ? x[k] : e.val; delete x[k]; } return x; });
      const headers = out.count !== null && out.count !== undefined ? { "content-range": `0-${Math.max(0, rows.length - 1)}/${out.count}` } : {};
      if (req.method === "HEAD") return send(200, undefined, headers);
      if (single) {
        if (rows.length !== 1) return rows.length === 0 && (req.headers.accept ?? "").includes("nulls=stripped") ? send(200, null) : send(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `${rows.length} rows` });
        return send(200, rows[0], headers);
      }
      return send(200, rows, headers);
    }
    send(404, { message: "not found" });
  } catch (e) {
    console.error(req.method, url.pathname, e.message);
    send(400, { code: e.code ?? "P0001", message: e.message, details: null, hint: null });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock supabase on ${PORT}`));
