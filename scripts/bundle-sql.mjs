// Concatène les migrations en un seul fichier à coller dans le SQL Editor de Supabase.
// Usage : npm run db:bundle  →  supabase/install.sql (généré, ne pas modifier à la main)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const body = files.map((f) => `-- ===== ${f} =====\n${readFileSync(join(dir, f), "utf8")}`).join("\n\n");
writeFileSync(
  join(dir, "..", "install.sql"),
  `-- Fichier généré par scripts/bundle-sql.mjs à partir de supabase/migrations.\n-- À exécuter une seule fois sur un projet Supabase vide.\n\n${body}`,
);
console.log(`supabase/install.sql : ${files.length} migrations`);
