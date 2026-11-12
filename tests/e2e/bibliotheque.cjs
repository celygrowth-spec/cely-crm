// Recette navigateur de la Bibliothèque, sur l'environnement de test local (npm run test-env).
// Usage : TEST_APP_PORT=3000 TEST_DB_PORT=54321 node tests/e2e/bibliotheque.cjs
// Aucune donnée réelle : base en mémoire, noms préfixés « [TEST] ».
let pw;
try { pw = require("playwright"); } catch { pw = require("playwright-core"); }
const { chromium } = pw;
const { context, sql, token } = require("../../scripts/test-env/browser.cjs");
const APP = `http://localhost:${process.env.TEST_APP_PORT ?? 3000}`;
const DB = Number(process.env.TEST_DB_PORT ?? 54321);
const q = (s, p) => sql(s, p, DB);
const one = async (s, p) => (await q(s, p))[0];
const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok }); console.log(`${ok ? "OK " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`); };
const file = (name, mimeType, text) => ({ name, mimeType, buffer: Buffer.from(text) });

async function mcp(tool, args) {
  // jeton OAuth simulé d'un client MCP (client_id) pour le compte propriétaire : lecture sous les vraies règles
  const parts = token("owner").split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  const t = [parts[0], Buffer.from(JSON.stringify({ ...claims, client_id: "claude-test-client" })).toString("base64url"), parts[2]].join(".");
  const r = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: ")) ?? raw;
  const msg = JSON.parse(line.replace(/^data: /, ""));
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  const text = msg.result.content[0].text;
  if (msg.result.isError) throw new Error(text);
  const i = text.indexOf("\n\n");
  return JSON.parse(text.startsWith("{") || text.startsWith("[") ? text : text.slice(i + 2));
}

(async () => {
  const browser = process.env.CHROMIUM ? await chromium.launch({ executablePath: process.env.CHROMIUM }) : await chromium.launch();
  const errors = [];
  const ctx = await context(browser, "owner", { permissions: ["clipboard-read", "clipboard-write"] });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept());
  const settle = () => p.waitForLoadState("networkidle");

  // 0. Document « ancien » déposé depuis Paramètres › Diagnostic (ancien écran) → dossier Bibliothèque diagnostic
  await p.goto(`${APP}/parametres/diagnostic`, { waitUntil: "networkidle" });
  await p.locator('input[type="file"]').setInputFiles([file("[TEST] Diagnostic exemple.pdf", "application/pdf", "%PDF-1.4 exemple")]);
  await p.getByRole("button", { name: "Télécharger [TEST] Diagnostic exemple.pdf" }).waitFor({ timeout: 15000 }); // envoi confirmé
  const legacy = await one(`select f.id, d.system_key from diagnostic_library_files f join library_folders d on d.id = f.folder_id where f.display_name = '[TEST] Diagnostic exemple.pdf'`);
  check("Dépôt depuis Paramètres › Diagnostic rangé dans « Bibliothèque diagnostic »", legacy?.system_key === "diagnostic");

  // 1. Bibliothèque : le dossier diagnostic est là, avec son document
  await p.goto(`${APP}/bibliotheque`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: /Bibliothèque diagnostic/ }).first().click();
  await p.getByText("[TEST] Diagnostic exemple.pdf").waitFor();
  check("Le dossier « Bibliothèque diagnostic » affiche le document de diagnostic", true);
  check("Dossier diagnostic sans bouton Supprimer", (await p.getByRole("button", { name: /^Supprimer$/ }).count()) === 0);

  // 2. Deux dossiers à la racine et un sous-dossier
  const mkFolder = async (name) => {
    await p.getByRole("button", { name: "Nouveau dossier" }).click();
    await p.getByRole("dialog").getByRole("textbox").fill(name);
    await p.getByRole("dialog").getByRole("button", { name: "Créer" }).dblclick(); // double clic volontaire
    await p.getByRole("dialog").waitFor({ state: "detached" });
    await settle();
  };
  await p.getByRole("button", { name: "Bibliothèque", exact: true }).click();
  await mkFolder("[TEST] Prompts");
  await mkFolder("[TEST] Modèles");
  const roots = await q(`select name from library_folders where parent_id is null order by name`);
  check("Deux dossiers créés à la racine (un seul par double clic)", roots.filter((r) => r.name.startsWith("[TEST]")).length === 2, roots.map((r) => r.name).join(", "));
  await p.getByRole("button", { name: /\[TEST\] Prompts/ }).first().click();
  await mkFolder("[TEST] LinkedIn");
  const sub = await one(`select s.id, s.parent_id = p.id ok from library_folders s join library_folders p on p.name = '[TEST] Prompts' where s.name = '[TEST] LinkedIn'`);
  check("Sous-dossier créé dans le dossier ouvert", sub?.ok === true);
  await p.getByRole("button", { name: /\[TEST\] LinkedIn/ }).first().click();
  const crumbs = (await p.getByRole("navigation", { name: "Fil d'Ariane" }).innerText()).replace(/\s+/g, " ");
  check("Fil d'Ariane", /Bibliothèque.*\[TEST\] Prompts.*\[TEST\] LinkedIn/.test(crumbs), crumbs);

  // 3. Dépôt multiple (sélection) avec un échec au milieu ; puis glisser-déposer
  await p.locator('input[type="file"]').setInputFiles([
    file("[TEST] Brief.pdf", "application/pdf", "%PDF-1.4 brief"),
    file("[TEST] Script.exe", "application/octet-stream", "MZ"),
    file("[TEST] Notes.txt", "text/plain", "notes"),
    file("[TEST] Brief.pdf", "application/pdf", "%PDF-1.4 brief bis"),
  ]);
  await p.getByText(/Échec : Format non autorisé/).waitFor({ timeout: 15000 });
  await p.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 15000 });
  await settle();
  const inLinkedIn = (await q(`select display_name from diagnostic_library_files where folder_id = $1 and status = 'ready' order by display_name`, [sub.id])).map((r) => r.display_name);
  check("Dépôt multiple : réussis conservés, nom en double renommé", JSON.stringify(inLinkedIn) === JSON.stringify(["[TEST] Brief (2).pdf", "[TEST] Brief.pdf", "[TEST] Notes.txt"]), inLinkedIn.join(", "));
  check("Dépôt multiple : l'échec est listé avec sa raison", (await p.getByText("[TEST] Script.exe").count()) === 1);
  const bilan = await p.getByText(/fichiers? ajoutés?, \d+ échec/).first().innerText().catch(() => "(aucun)");
  check("Message de bilan du dépôt", /3 fichiers ajoutés, 1 échec/.test(bilan), bilan);
  const dt = await p.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["%PDF-1.4 dd"], "[TEST] Glissé.pdf", { type: "application/pdf" })); return d; });
  await p.locator("div.rounded-2xl").first().dispatchEvent("drop", { dataTransfer: dt });
  await p.getByRole("button", { name: "Télécharger [TEST] Glissé.pdf" }).waitFor({ timeout: 15000 });
  check("Glisser-déposer : fichier ajouté au dossier ouvert", (await one(`select count(*)::int n from diagnostic_library_files where folder_id = $1 and display_name = '[TEST] Glissé.pdf'`, [sub.id])).n === 1);
  const obj = await one(`select count(*)::int n from storage.objects o join diagnostic_library_files f on f.storage_path = o.name where f.folder_id = $1 and o.bucket_id = 'diagnostic-library'`, [sub.id]);
  check("Fichiers présents dans le stockage privé", obj.n === 4, `${obj.n} objets`);

  // 4. Nouveau prompt, modification, copie
  await p.getByRole("button", { name: "Nouveau prompt" }).click();
  const dlg = p.getByRole("dialog");
  await dlg.getByRole("textbox").first().fill("[TEST] Relance J+3");
  await dlg.locator("textarea").fill("Bonjour {prénom},\nje reviens vers vous au sujet de notre échange.");
  await dlg.getByRole("button", { name: "Créer le prompt" }).dblclick();
  await dlg.waitFor({ state: "detached" });
  await settle();
  check("Prompt créé une seule fois malgré le double clic", (await one(`select count(*)::int n from diagnostic_library_files where kind = 'prompt' and display_name = '[TEST] Relance J+3'`)).n === 1);
  await p.getByRole("button", { name: "Copier [TEST] Relance J+3" }).click();
  await p.waitForTimeout(400);
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check("Copier : le contenu est dans le presse-papiers", clip.startsWith("Bonjour {prénom},\nje reviens"), JSON.stringify(clip.slice(0, 40)));
  await p.getByRole("button", { name: /^\[TEST\] Relance J\+3$/ }).click();
  await p.getByRole("dialog").locator("textarea").waitFor();
  await p.waitForFunction(() => (document.querySelector('dialog textarea')?.value ?? "").length > 0);
  await p.getByRole("dialog").locator("textarea").fill("Texte modifié");
  await p.getByRole("dialog").getByRole("button", { name: "Enregistrer" }).click();
  await p.getByRole("dialog").waitFor({ state: "detached" });
  check("Prompt modifiable ensuite", (await one(`select content from diagnostic_library_files where display_name = '[TEST] Relance J+3'`)).content === "Texte modifié");

  // 5. Déplacer : un fichier vers un autre dossier ; un dossier jamais dans lui-même
  await p.getByRole("button", { name: "Déplacer [TEST] Notes.txt" }).click();
  await p.getByRole("dialog").getByRole("combobox").selectOption({ label: "[TEST] Modèles" });
  await p.getByRole("dialog").getByRole("button", { name: "Déplacer" }).click();
  await p.getByRole("dialog").waitFor({ state: "detached" });
  const moved = await one(`select d.name from diagnostic_library_files f join library_folders d on d.id = f.folder_id where f.display_name = '[TEST] Notes.txt'`);
  check("Élément déplacé vers « [TEST] Modèles »", moved?.name === "[TEST] Modèles");
  await p.getByRole("button", { name: "[TEST] Prompts", exact: true }).click(); // fil d'Ariane
  await p.getByRole("button", { name: "Déplacer", exact: true }).click();
  const options = await p.getByRole("dialog").getByRole("combobox").locator("option").allInnerTexts();
  check("Dossier : ni lui-même ni ses sous-dossiers parmi les destinations", !options.some((o) => /LinkedIn|^\[TEST\] Prompts$/.test(o)), options.join(" | "));
  await p.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();
  // et la base refuse même si la demande est forgée
  const forged = await p.evaluate(async ([id, parent]) => (await fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "folder_move", id, parent }) })).json(),
    [(await one(`select id from library_folders where name = '[TEST] Prompts'`)).id, sub.id]);
  check("Déplacement forgé d'un dossier dans son sous-dossier refusé par la base", forged.ok === false, forged.error);
  // déplacer le sous-dossier vers « Bibliothèque diagnostic »
  await p.getByRole("button", { name: "Déplacer le dossier [TEST] LinkedIn" }).click();
  await p.getByRole("dialog").getByRole("combobox").selectOption({ label: "Bibliothèque diagnostic" });
  await p.getByRole("dialog").getByRole("button", { name: "Déplacer" }).click();
  await p.getByRole("dialog").waitFor({ state: "detached" });
  check("Sous-dossier déplacé dans « Bibliothèque diagnostic »", (await one(`select p.system_key from library_folders s join library_folders p on p.id = s.parent_id where s.name = '[TEST] LinkedIn'`)).system_key === "diagnostic");

  // 6. Recherche sur toute la bibliothèque
  await p.getByLabel("Rechercher par nom dans toute la bibliothèque").fill("brief");
  const found = await p.getByRole("region", { name: "Résultats de recherche" }).innerText();
  check("Recherche par nom sur toute la bibliothèque", found.includes("[TEST] Brief.pdf") && found.includes("[TEST] Brief (2).pdf") && found.includes("Bibliothèque diagnostic › [TEST] LinkedIn"));
  await p.getByLabel("Rechercher par nom dans toute la bibliothèque").fill("");

  // 7. Le diagnostic lit toujours ses documents, sous-dossiers compris ; le MCP lit toute la bibliothèque
  // open_diagnostic lit la bibliothèque par getLibrary, la même fonction que /api/diagnostic-library. L'outil lui-même
  // n'est pas exécutable ici : le faux PostgREST local ne gère pas les relations à alias (questions:diagnostic_questions).
  const lib = await p.evaluate(async () => (await fetch("/api/diagnostic-library")).json());
  const names = (lib.files ?? []).map((f) => f.display_name);
  check("Lecture du diagnostic (getLibrary) : document de diagnostic + sous-dossier déplacé dedans, rien d'autre", names.includes("[TEST] Diagnostic exemple.pdf") && names.includes("[TEST] Brief.pdf") && !names.includes("[TEST] Notes.txt"), names.join(", "));
  check("Lecture du diagnostic : identifiant d'origine conservé", (lib.files ?? []).some((f) => f.id === legacy.id));
  const url = await mcp("get_library_file_url", { file_id: legacy.id }).catch((e) => ({ error: e.message }));
  check("get_library_file_url : lien temporaire vers le document de diagnostic (même identifiant)", url.expire_dans_secondes === 300, url.error ?? "");
  const folders = await mcp("list_library_folders", {}).catch((e) => ({ error: e.message }));
  check("list_library_folders (MCP)", Array.isArray(folders) && folders.some((f) => f.chemin === "[TEST] Modèles"), folders.error ?? `${folders.length} dossiers`);
  const items = await mcp("list_library_items", { query: "relance" }).catch((e) => ({ error: e.message }));
  const promptId = items.elements?.[0]?.id;
  const prompt = promptId ? await mcp("get_library_prompt", { prompt_id: promptId }).catch((e) => ({ error: e.message })) : {};
  check("list_library_items + get_library_prompt (MCP)", prompt.contenu === "Texte modifié", prompt.error ?? items.error ?? "");
  const write = await fetch(`${APP}/api/library`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ op: "folder_create", name: "intrus" }) });
  check("Écriture sans session refusée", write.status === 401);

  // 8. Suppression d'un dossier : confirmation avec le nombre d'éléments
  await p.goto(`${APP}/bibliotheque`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Supprimer le dossier [TEST] Modèles" }).click();
  const confirmText = await p.getByRole("dialog").innerText();
  check("Confirmation annonçant le nombre d'éléments", /contient 1 élément/.test(confirmText), confirmText.replace(/\s+/g, " ").slice(0, 120));
  await p.getByRole("dialog").getByRole("button", { name: /Supprimer le dossier et 1 élément/ }).click();
  await p.getByRole("dialog").waitFor({ state: "detached" });
  check("Dossier supprimé avec son contenu", (await one(`select count(*)::int n from library_folders where name = '[TEST] Modèles'`)).n === 0 && (await one(`select count(*)::int n from diagnostic_library_files where display_name = '[TEST] Notes.txt'`)).n === 0);

  // 9. Compte connecté sans droit : rien de visible, rien de possible
  const ctx2 = await context(browser, "stranger");
  const s = await ctx2.newPage();
  const r = await s.goto(`${APP}/api/library`);
  check("Compte sans droit : lecture refusée", r.status() === 403, String(r.status()));
  const forged2 = await s.evaluate(async (id) => (await fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "file_url", id, download: true }) })).json(), legacy.id).catch((e) => ({ ok: false, error: e.message }));
  check("Compte sans droit : lien vers un document de diagnostic refusé (identifiant valide)", forged2.ok === false, forged2.error);

  check("Aucune erreur JavaScript", errors.length === 0, errors.join(" | "));
  await p.screenshot({ path: process.env.SHOT ?? "bibliotheque.png", fullPage: true });
  await browser.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
