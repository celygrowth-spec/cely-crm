// Sessions de test pour Playwright : comptes contrôlés de l'environnement local (aucun compte réel).
const ACCOUNTS = {
  owner: { id: "00000000-0000-0000-0000-000000000001", email: "test-owner@example.test" },
  stranger: { id: "00000000-0000-0000-0000-000000000002", email: "test-stranger@example.test" },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Jeton non signé : accepté uniquement par la base de test locale. */
function token(who = "owner") {
  const a = ACCOUNTS[who];
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: a.id, email: a.email, role: "authenticated", aud: "authenticated", exp: 4102444800 })}.test`;
}
async function context(browser, who = "owner", opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "Europe/Paris", locale: "fr-FR", ...opts });
  const a = ACCOUNTS[who];
  const session = { access_token: token(who), refresh_token: "r", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user: { id: a.id, email: a.email } };
  await ctx.addCookies([{ name: "sb-127-auth-token", value: "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"), domain: "localhost", path: "/" }]);
  return ctx;
}
async function sql(q, params, port = Number(process.env.TEST_DB_PORT ?? 54321)) {
  const r = await fetch(`http://127.0.0.1:${port}/debug/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, params }) });
  if (!r.ok) throw new Error((await r.json()).message);
  return r.json();
}
module.exports = { ACCOUNTS, token, context, sql };
