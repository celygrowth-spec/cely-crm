// Faux lemlist pour l'environnement de test local : réponses de forme officielle (developer.lemlist.com), données
// fictives, aucun appel au vrai lemlist. Deux clés fictives = deux comptes clients ; toute autre clé est refusée (401).
// Usage : node scripts/test-env/lemlist-fake.mjs [port]   (n'écoute que sur 127.0.0.1)
import http from "node:http";

const PORT = Number(process.argv[2] ?? 54400);

export const FAKE_KEYS = {
  "test-lemlist-alpha-0001": { _id: "tea_testAlpha", name: "[TEST] Équipe Alpha", userIds: ["usr_testAlpha1"] },
  "test-lemlist-beta-0002": { _id: "tea_testBeta", name: "[TEST] Équipe Beta", userIds: ["usr_testBeta1"] },
};
// clés « révoquées » pendant la recette : POST /__revoke {key}
const revoked = new Set();

const keyOf = (auth) => Buffer.from(String(auth ?? "").replace(/^Basic /, ""), "base64").toString("utf8").replace(/^:/, "");

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let raw = "";
  for await (const c of req) raw += c;
  if (url.pathname === "/__revoke" && req.method === "POST") {
    revoked.add(JSON.parse(raw || "{}").key);
    return send(200, { ok: true });
  }
  const key = keyOf(req.headers.authorization);
  const team = FAKE_KEYS[key];
  if (!team || revoked.has(key)) return send(401, "The authentication you supplied is incorrect", "text/plain");
  if (url.pathname === "/api/team" && req.method === "GET") return send(200, { ...team, createdBy: team.userIds[0], createdAt: "2026-01-01T00:00:00.000Z" });
  return send(404, "Not found", "text/plain");
});

if (import.meta.url === `file://${process.argv[1]}`) server.listen(PORT, "127.0.0.1", () => console.log(`Faux lemlist sur http://127.0.0.1:${PORT}`));
