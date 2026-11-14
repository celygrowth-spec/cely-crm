// Lance l'environnement de test : base locale (scripts/test-env/server.mjs) + application Next.js reliée à elle.
// Les variables passées ici l'emportent sur .env.local : l'application ne peut pas atteindre la production.
// Usage : node scripts/test-env/dev.mjs            (développement, port 3000)
//         node scripts/test-env/dev.mjs --prod     (build déjà fait : next start, pour les mesures de performance)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const DB_PORT = Number(process.env.TEST_DB_PORT ?? 54321);
const APP_PORT = Number(process.env.TEST_APP_PORT ?? 3000);
const LEMLIST_PORT = Number(process.env.TEST_LEMLIST_PORT ?? 54400);
const serverKey = process.env.SERVER_KEY ?? randomBytes(24).toString("base64url");
export const TEST_ENV = {
  SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
  SUPABASE_PUBLISHABLE_KEY: "anon-key-local",
  APP_URL: `http://localhost:${APP_PORT}`,
  APPOINTMENTS_SECRET: process.env.APPOINTMENTS_SECRET ?? randomBytes(32).toString("base64"),
  CRON_SECRET: process.env.CRON_SECRET ?? "test-cron-secret",
  // aucun identifiant Google, Gmail, Fireflies ou Claude réel : les intégrations restent simulées ou désactivées
  GOOGLE_CALENDAR_CLIENT_ID: "", GOOGLE_CALENDAR_CLIENT_SECRET: "", GOOGLE_MAIL_CLIENT_ID: "", GOOGLE_MAIL_CLIENT_SECRET: "",
  FIREFLIES_API_KEY: "", FIREFLIES_WEBHOOK_SECRET: "", DIAGNOSTIC_ROUTINE_URL: "", ONBOARDING_ROUTINE_URL: "",
  // chiffrement local (jamais celui de la production) et faux lemlist (scripts/test-env/lemlist-fake.mjs)
  MAIL_TOKEN_KEY: randomBytes(32).toString("base64"),
  LEMLIST_API_URL: `http://127.0.0.1:${LEMLIST_PORT}`,
  CELY_TEST_ENV: "1",
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = spawn(process.execPath, ["scripts/test-env/server.mjs", String(DB_PORT)], { stdio: "inherit", env: { ...process.env, SERVER_KEY: serverKey } });
  const lemlist = spawn(process.execPath, ["scripts/test-env/lemlist-fake.mjs", String(LEMLIST_PORT)], { stdio: "inherit" });
  const prod = process.argv.includes("--prod");
  const app = spawn("npx", ["next", prod ? "start" : "dev", "-p", String(APP_PORT)], { stdio: "inherit", env: { ...process.env, ...TEST_ENV } });
  const stop = () => { db.kill(); lemlist.kill(); app.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
