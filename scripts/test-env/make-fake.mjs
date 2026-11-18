// Faux Make pour l'environnement de test : aucun scénario réel n'est appelé.
//   POST /hook/<nom>   reçoit un appel du CRM et le garde en mémoire ; /hook/panne répond 500, /hook/lent attend 15 s
//   GET  /calls        appels reçus (pour les vérifications)      DELETE /calls   remise à zéro
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.TEST_MAKE_PORT ?? 54410);
const calls = [];

createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/calls" && req.method === "GET") return send(200, calls);
  if (req.url === "/calls" && req.method === "DELETE") { calls.length = 0; return send(200, { ok: true }); }
  if (req.method !== "POST" || !req.url?.startsWith("/hook/")) return send(404, { error: "inconnu" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const name = req.url.slice(6);
  let body = null;
  try { body = JSON.parse(raw); } catch { /* gardé tel quel */ }
  calls.push({ hook: name, at: new Date().toISOString(), body });
  if (name === "panne") return send(500, { error: "panne simulée" });
  if (name === "lent") await new Promise((r) => setTimeout(r, 15_000));
  send(200, { accepted: true });
}).listen(port, "127.0.0.1", () => console.log(`[make-fake] http://127.0.0.1:${port}`));
