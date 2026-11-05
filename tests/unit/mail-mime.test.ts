import { expect, test } from "vitest";
import { buildMime } from "@/lib/mail/mime";
import { isEmail, splitAddresses, withSignature } from "@/lib/mail/types";

const base = { from: { email: "moi@cely.fr", name: "Célien B." }, to: ["a@b.fr"], subject: "Bonjour", text: "Texte" };

function parts(buf: Buffer) {
  const s = buf.toString();
  const [head] = s.split("\r\n\r\n");
  return { s, head };
}

test("en-têtes : objet accentué encodé, expéditeur, MIME", () => {
  const { head } = parts(buildMime({ ...base, subject: "Réunion à Paris — été" }));
  expect(head).toContain("To: a@b.fr");
  expect(head).toContain("MIME-Version: 1.0");
  expect(head).toContain("=?UTF-8?B?");
  expect(head).not.toContain("Réunion");
  const decoded = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], "base64").toString()).join("");
  expect(decoded).toContain("Réunion à Paris — été");
});

test("injection d'en-têtes refusée dans l'objet, les adresses, le nom de fichier et les références", () => {
  expect(() => buildMime({ ...base, subject: "x\r\nBcc: pirate@evil.fr" })).toThrow(/interdit/);
  expect(() => buildMime({ ...base, to: ["a@b.fr\r\nBcc: pirate@evil.fr"] })).toThrow();
  expect(() => buildMime({ ...base, inReplyTo: "<a>\nBcc: x@y.fr" })).toThrow(/interdit/);
  expect(() => buildMime({ ...base, attachments: [{ name: "a\r\nX: y.pdf", mimeType: "application/pdf", data: Buffer.from("x") }] })).toThrow(/interdit/);
  expect(() => buildMime({ ...base, attachments: [{ name: "a.pdf", mimeType: "text/plain\r\nX: y", data: Buffer.from("x") }] })).toThrow();
});

test("adresse invalide ou absence de destinataire", () => {
  expect(() => buildMime({ ...base, to: ["pas-une-adresse"] })).toThrow(/invalide/);
  expect(() => buildMime({ ...base, to: [] })).toThrow(/destinataire/);
});

test("pièce jointe : multipart, nom encodé, contenu intact ; CC et CCI présents", () => {
  const data = Buffer.from("%PDF contenu binaire é");
  const { s } = parts(buildMime({ ...base, cc: ["c@d.fr"], bcc: ["e@f.fr"], attachments: [{ name: "Proposition été.pdf", mimeType: "application/pdf", data }] }));
  expect(s).toContain("multipart/mixed");
  expect(s).toContain("Cc: c@d.fr");
  expect(s).toContain("Bcc: e@f.fr");
  expect(s).toContain("filename*=UTF-8''Proposition%20%C3%A9t%C3%A9.pdf");
  expect(s).toContain(data.toString("base64"));
  expect(s).toContain(Buffer.from("Texte").toString("base64"));
});

test("réponse : en-têtes de fil", () => {
  const { head } = parts(buildMime({ ...base, inReplyTo: "<x@mail>", references: "<w@mail> <x@mail>" }));
  expect(head).toContain("In-Reply-To: <x@mail>");
  expect(head).toContain("References: <w@mail> <x@mail>");
});

test("texte et HTML : alternative", () => {
  const { s } = parts(buildMime({ ...base, html: "<p>Salut</p>" }));
  expect(s).toContain("multipart/alternative");
});

test("signature, adresses", () => {
  expect(withSignature("Bonjour\n", "Célien")).toBe("Bonjour\n\n-- \nCélien");
  expect(withSignature("Bonjour", "  ")).toBe("Bonjour");
  expect(splitAddresses("a@b.fr, c@d.fr ; e@f.fr")).toEqual(["a@b.fr", "c@d.fr", "e@f.fr"]);
  expect(isEmail("a@b.fr")).toBe(true);
  for (const bad of ["a@b", "a b@c.fr", "<a@b.fr>", "a@b.fr,c@d.fr"]) expect(isEmail(bad)).toBe(false);
});
