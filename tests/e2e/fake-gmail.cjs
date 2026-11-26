// Gmail simulé pour la recette locale (chargé avec NODE_OPTIONS=--require dans le serveur Next de TEST uniquement).
// Intercepte les appels HTTP vers Google : renouvellement d'accès et envoi. Chaque message « envoyé » est écrit dans
// FAKE_GMAIL_DIR ; la présence du fichier FAKE_GMAIL_DIR/fail fait refuser l'envoi (échec certain, HTTP 400).
// N'a aucun effet sans FAKE_GMAIL_DIR, et ne fait jamais partie de l'application.
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = process.env.FAKE_GMAIL_DIR;
if (dir && process.env.CELY_TEST_ENV === "1") {
  mkdirSync(dir, { recursive: true });
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "acces-simule", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.send", token_type: "Bearer" });
    if (url.startsWith("https://gmail.googleapis.com/")) {
      if (existsSync(join(dir, "fail"))) return json(400, { error: { message: "Envoi refusé (simulation)", errors: [{ reason: "invalidArgument" }] } });
      n += 1;
      const raw = Buffer.from(init?.body ?? "").toString("utf8");
      writeFileSync(join(dir, `message-${Date.now()}-${n}.eml`), raw);
      return json(200, { id: `simule-${n}`, threadId: `fil-${n}` });
    }
    return real(input, init);
  };
}
