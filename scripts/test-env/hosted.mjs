// Lance l'application reliée au projet Supabase de TEST hébergé décrit dans .env.test.local.
// Refuse si le fichier manque ou si son URL est celle de .env.local (la production).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const parse = (f) => Object.fromEntries(readFileSync(f, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
if (!existsSync(".env.test.local")) { console.error("Créez .env.test.local à partir de .env.test.example (projet Supabase de test)."); process.exit(1); }
const test = parse(".env.test.local");
const prod = existsSync(".env.local") ? parse(".env.local") : {};
if (!test.SUPABASE_URL || test.SUPABASE_URL.includes("<")) { console.error("SUPABASE_URL de test manquante dans .env.test.local."); process.exit(1); }
if (prod.SUPABASE_URL && prod.SUPABASE_URL === test.SUPABASE_URL) { console.error("Refus : .env.test.local pointe vers la même base que .env.local (production)."); process.exit(1); }
const env = { ...process.env, ...test, CELY_TEST_ENV: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "", GOOGLE_MAIL_CLIENT_ID: "", FIREFLIES_API_KEY: "", DIAGNOSTIC_ROUTINE_URL: "", ONBOARDING_ROUTINE_URL: "" };
spawn("npx", ["next", "dev", "-p", "3000"], { stdio: "inherit", env });
