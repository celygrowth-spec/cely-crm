// Le fichier unique supabase/install.sql s'applique d'un bloc sur une base vide.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("install.sql s'applique en une fois", async () => {
  const pg = new PGlite({ extensions: { pg_trgm, unaccent } });
  await pg.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text);
    alter table storage.objects enable row level security;`);
  await pg.exec(readFileSync(join(import.meta.dirname, "..", "..", "supabase", "install.sql"), "utf8"));
  const r = await pg.query<{ n: number }>(`select count(*)::int as n from public.lead_sources`);
  expect(r.rows[0].n).toBe(8);
});
