// CMS lot 2 en base : bucket public d'images (formats sûrs, sans SVG), envoi et suppression réservés au propriétaire.
import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

test("bucket public, images seulement, SVG refusé", async () => {
  await db.exec("reset role");
  const b = await db.one<{ public: boolean; allowed_mime_types: string[] }>(`select public, allowed_mime_types from storage.buckets where id = 'cms-media'`);
  expect(b.public).toBe(true);
  expect(b.allowed_mime_types).not.toContain("image/svg+xml");
  await db.as("owner");
  await expect(db.query(`insert into cms_media (path, filename, mime, size) values ($1, 'a.svg', 'image/svg+xml', 10)`, [`${randomUUID()}.svg`])).rejects.toThrow(/check constraint/);
});

test("propriétaire : envoi et suppression ; second compte, Claude, visiteur : refusés", async () => {
  const path = `${randomUUID()}.png`;
  await db.query(`insert into cms_media (path, filename, mime, size) values ($1, 'a.png', 'image/png', 10)`, [path]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('cms-media', $1)`, [path]);
  for (const who of ["stranger", "claude"] as const) {
    await db.as(who);
    await expect(db.query(`insert into cms_media (path, filename, mime, size) values ($1, 'b.png', 'image/png', 10)`, [`${randomUUID()}.png`])).rejects.toThrow(/row-level security/);
    await expect(db.query(`insert into storage.objects (bucket_id, name) values ('cms-media', $1)`, [`${randomUUID()}.png`])).rejects.toThrow(/row-level security/);
    expect((await db.query(`delete from storage.objects where bucket_id = 'cms-media' returning name`)).rows).toEqual([]);
    expect((await db.query(`delete from cms_media returning id`)).rows).toEqual([]);
  }
  await db.as("anon");
  await expect(db.query(`select * from cms_media`)).rejects.toThrow(/permission denied/);
  await db.as("owner");
  expect((await db.query(`delete from storage.objects where bucket_id = 'cms-media' returning name`)).rows).toHaveLength(1);
  expect((await db.query(`delete from cms_media returning id`)).rows).toHaveLength(1);
});
