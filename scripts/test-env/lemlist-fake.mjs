// Faux lemlist pour l'environnement de test local : réponses de forme officielle (developer.lemlist.com), données
// fictives, aucun appel au vrai lemlist. Deux clés fictives = deux comptes clients ; toute autre clé est refusée (401).
// Usage : node scripts/test-env/lemlist-fake.mjs [port]   (n'écoute que sur 127.0.0.1)
// Pilotage de la recette : POST /__revoke {key} (clé révoquée), POST /__limit {key} (débit dépassé : 429),
// POST /__reply {key, contactId, text, channel} (nouvelle réponse du contact), GET /__sent (envois reçus).
import http from "node:http";

const PORT = Number(process.argv[2] ?? 54400);
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

export const FAKE_KEYS = {
  "test-lemlist-alpha-0001": { _id: "tea_testAlpha", name: "[TEST] Équipe Alpha", userIds: ["usr_testAlpha1", "usr_testAlpha2"] },
  "test-lemlist-beta-0002": { _id: "tea_testBeta", name: "[TEST] Équipe Beta", userIds: ["usr_testBeta1"] },
};

const SENDERS = {
  usr_testAlpha1: { name: "Léa Alpha", email: "lea@alpha.example.test", mailbox: "usm_testAlpha1" },
  usr_testAlpha2: { name: "Marc Alpha", email: "marc@alpha.example.test", mailbox: "usm_testAlpha2" },
  usr_testBeta1: { name: "Nora Beta", email: "nora@beta.example.test", mailbox: "usm_testBeta1" },
};

/** Conversations et messages par équipe. users : membres qui suivent la conversation (lu / non lu). */
const DATA = {
  tea_testAlpha: [
    { id: "ibx_testA1", contact: { _id: "ctc_testA1", fullName: "[TEST] Camille Martin", email: "camille@prospect.example.test" }, users: [["usr_testAlpha1", false], ["usr_testAlpha2", true]], lead: "lea_testA1",
      messages: [["emailsSent", 300, "<p>Bonjour Camille,</p><p>Je me permets de vous écrire au sujet de vos recrutements.</p>", "Vos recrutements"], ["emailsReplied", 30, "<div>Bonjour, oui ça m'intéresse, pouvez-vous m'en dire plus ?</div><blockquote class=\"gmail_quote\">Bonjour Camille, je me permets…</blockquote>", "Re: Vos recrutements"]] },
    { id: "ibx_testA2", contact: { _id: "ctc_testA2", fullName: "[TEST] Hugo Leroy" }, users: [["usr_testAlpha2", true]], lead: "lea_testA2",
      messages: [["linkedinSent", 2000, "Bonjour Hugo, ravi d'échanger avec vous.", null], ["linkedinReplied", 1500, "Merci, avec plaisir. Revenez vers moi en janvier.", null]] },
    { id: "ibx_testA3", contact: { _id: "ctc_testA3", fullName: "[TEST] Sarah Diallo", email: "sarah@prospect.example.test" }, users: [["usr_testAlpha1", true]], lead: "lea_testA3",
      messages: [["emailsSent", 5000, "<p>Bonjour Sarah,</p><p>Premier message.</p>", "Présentation"], ["linkedinSent", 4000, "Bonjour Sarah, je vous ai écrit par email.", null], ["emailsOpened", 3900, "", null]] },
    // WhatsApp seulement : hors version, ne doit pas apparaître
    { id: "ibx_testA4", channels: ["whatsapp"], contact: { _id: "ctc_testA4", fullName: "[TEST] Hors canal" }, users: [["usr_testAlpha1", false]], lead: "lea_testA4", messages: [] },
  ],
  tea_testBeta: [
    // même contact (même email) que chez Alpha : conversation distincte
    { id: "ibx_testB1", contact: { _id: "ctc_testB1", fullName: "[TEST] Camille Martin", email: "camille@prospect.example.test" }, users: [["usr_testBeta1", false]], lead: "lea_testB1",
      messages: [["emailsSent", 600, "<p>Bonjour Camille, offre Beta.</p>", "Offre Beta"], ["emailsReplied", 10, "<p>Pas pour le moment, merci.</p>", "Re: Offre Beta"]] },
    { id: "ibx_testB2", contact: { _id: "ctc_testB2", fullName: "[TEST] Paul Bernard" }, users: [["usr_testBeta1", false]], lead: "lea_testB2",
      messages: [["linkedinSent", 900, "Bonjour Paul, merci pour l'invitation.", null], ["linkedinReplied", 60, "Avec plaisir ! Quel est votre tarif ?", null]] },
  ],
};

// messages en mémoire (horodatés au lancement), complétés par les réponses simulées et les envois reçus
const messages = new Map();
for (const [team, convs] of Object.entries(DATA)) {
  for (const c of convs) {
    const sender = c.users[0][0];
    messages.set(c.contact._id, c.messages.map(([type, min, body, subject], i) => ({
      _id: `act_${c.id}_${i}`, type, createdAt: ago(min), teamId: team, contactId: c.contact._id, leadId: c.lead,
      ...(type.endsWith("Sent") ? { sendUserId: sender, sendUserName: SENDERS[sender].name, sendUserEmail: SENDERS[sender].email, sendUserMailboxId: SENDERS[sender].mailbox } : {}),
      ...(type.endsWith("Replied") && type.startsWith("email") ? { fromEmail: c.contact.email } : {}),
      message: body, ...(subject ? { subject } : {}),
    })));
  }
}

const revoked = new Set();
const sendFail = new Map(); // clé → "error" (refus 400) | "timeout" (aucune réponse)
const limited = new Set();
const sent = [];
const keyOf = (auth) => Buffer.from(String(auth ?? "").replace(/^Basic /, ""), "base64").toString("utf8").replace(/^:/, "");

function conversation(team, c) {
  const list = messages.get(c.contact._id) ?? [];
  const last = list.at(-1);
  const replies = list.filter((m) => m.type.endsWith("Replied"));
  const channels = c.channels ?? [...new Set(list.map((m) => (m.type.startsWith("email") ? "email" : "linkedin")))];
  return {
    _id: c.id, opportunities: [], lastActivityAt: last?.createdAt ?? ago(10_000), createdBy: list[0]?._id, channels, teamId: team,
    contactId: c.contact._id, users: c.users.map(([userId, read]) => ({ userId, sender: true, read })), createdAt: list[0]?.createdAt ?? ago(10_000),
    haveReplies: replies.length > 0, lastRepliedAt: replies.at(-1)?.createdAt, lastRepliedChannel: replies.at(-1)?.type.startsWith("email") ? "email" : replies.length ? "linkedin" : undefined,
    contact: c.contact,
  };
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19", ...(status === 429 ? { "retry-after": "2" } : {}) });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let raw = "";
  for await (const c of req) raw += c;
  const input = () => JSON.parse(raw || "{}");
  if (url.pathname === "/__revoke" && req.method === "POST") { revoked.add(input().key); return send(200, { ok: true }); }
  if (url.pathname === "/__limit" && req.method === "POST") { const { key, off } = input(); if (off) limited.delete(key); else limited.add(key); return send(200, { ok: true }); }
  if (url.pathname === "/__sent" && req.method === "GET") return send(200, sent);
  if (url.pathname === "/__sendfail" && req.method === "POST") { const { key, mode } = input(); if (mode === "off") sendFail.delete(key); else sendFail.set(key, mode); return send(200, { ok: true }); }
  if (url.pathname === "/__reply" && req.method === "POST") {
    const { key, contactId, text, channel = "email" } = input();
    const team = FAKE_KEYS[key]?._id;
    const c = DATA[team]?.find((x) => x.contact._id === contactId);
    if (!c) return send(404, { error: "inconnu" });
    messages.get(contactId).push({ _id: `act_reply_${Date.now()}`, type: channel === "email" ? "emailsReplied" : "linkedinReplied", createdAt: new Date().toISOString(), teamId: team, contactId, leadId: c.lead, message: text, ...(channel === "email" ? { fromEmail: c.contact.email, subject: "Re:" } : {}) });
    for (const u of c.users) u[1] = false;
    return send(200, { ok: true });
  }

  const key = keyOf(req.headers.authorization);
  const team = FAKE_KEYS[key];
  if (!team || revoked.has(key)) return send(401, "The authentication you supplied is incorrect", "text/plain");
  if (limited.has(key)) return send(429, "Too many requests", "text/plain");
  if (url.pathname === "/api/team" && req.method === "GET") return send(200, { ...team, createdBy: team.userIds[0], createdAt: "2026-01-01T00:00:00.000Z" });
  if (url.pathname === "/api/inbox" && req.method === "GET") {
    const userId = url.searchParams.get("userId");
    if (!userId) return send(400, "User ID is required", "text/plain");
    if (!team.userIds.includes(userId)) return send(400, "User not in team", "text/plain");
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const all = DATA[team._id].filter((c) => c.users.some(([u]) => u === userId)).map((c) => conversation(team._id, c)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const data = all.slice((page - 1) * limit, page * limit);
    const totalPages = Math.max(1, Math.ceil(all.length / limit));
    return send(200, { data, pagination: { totalItems: all.length, currentPage: page, nextPage: page < totalPages ? page + 1 : null, previousPage: page > 1 ? page - 1 : null, perPage: limit, totalPages } });
  }
  if ((url.pathname === "/api/inbox/email" || url.pathname === "/api/inbox/linkedin") && req.method === "POST") {
    const b = input();
    const channel = url.pathname.endsWith("email") ? "email" : "linkedin";
    const c = DATA[team._id].find((x) => x.contact._id === b.contactId);
    if (!team.userIds.includes(b.sendUserId)) return send(400, "Invalid sendUserId", "text/plain");
    if (!c) return send(400, "Invalid contactId", "text/plain");
    if (channel === "email" && (!b.sendUserEmail || !b.sendUserMailboxId || !b.message)) return send(400, "Invalid sendUserMailboxId", "text/plain");
    if (channel === "linkedin" && (b.leadId !== c.lead || !b.message)) return send(400, "Invalid leadId", "text/plain");
    const mode = sendFail.get(key);
    if (mode === "error") return send(400, channel === "email" ? "Failed to send email" : "Failed to send message", "text/plain");
    const u = SENDERS[b.sendUserId];
    messages.get(c.contact._id).push({ _id: `act_api_${Date.now()}`, type: channel === "email" ? "emailsSent" : "linkedinSent", createdAt: new Date().toISOString(), teamId: team._id, contactId: c.contact._id, leadId: c.lead, sendUserId: b.sendUserId, sendUserName: u.name, sendUserEmail: u.email, sendUserMailboxId: u.mailbox, message: b.message, ...(channel === "email" ? { subject: "Re:" } : {}) });
    sent.push({ team: team._id, channel, contactId: c.contact._id, sendUserId: b.sendUserId, at: new Date().toISOString() });
    if (mode === "timeout") return; // l'envoi est enregistré mais la réponse ne revient jamais (cas « incertain »)
    return send(200, channel === "email" ? { ok: true, contactId: c.contact._id } : { ok: true });
  }
  const m = url.pathname.match(/^\/api\/inbox\/(ctc_[A-Za-z0-9]+)$/);
  if (m && req.method === "GET") {
    const c = DATA[team._id].find((x) => x.contact._id === m[1]);
    if (!c) return send(400, "Invalid contactId", "text/plain");
    const list = [...(messages.get(m[1]) ?? [])].reverse(); // le plus récent d'abord
    return send(200, { data: list, pagination: { totalItems: list.length, currentPage: 1, nextPage: null, previousPage: null, perPage: list.length, totalPages: 1 } });
  }
  return send(404, "Not found", "text/plain");
});

if (import.meta.url === `file://${process.argv[1]}`) server.listen(PORT, "127.0.0.1", () => console.log(`Faux lemlist sur http://127.0.0.1:${PORT}`));
