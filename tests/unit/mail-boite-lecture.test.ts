// Mail, lot M02 : lecture d'un fil Gmail et nettoyage du HTML reçu (contenus fictifs).
import { describe, expect, test } from "vitest";
import { cleanEmailHtml } from "@/lib/mail/box";
import { toFullMessage } from "@/lib/mail/gmail-box";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("message complet", () => {
  test("corps HTML et texte, destinataires complets, pièces jointes dans l'ordre (y compris imbriquées)", () => {
    const m = toFullMessage({
      id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1700000000000",
      payload: {
        headers: [{ name: "From", value: "Claire Test <claire@example.test>" }, { name: "To", value: "Moi <moi@example.test>, autre@example.test" }, { name: "Cc", value: "copie@example.test" }, { name: "Subject", value: "Devis" }],
        parts: [
          { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Bonjour é") } }, { mimeType: "text/html", body: { data: b64("<p>Bonjour é</p>") } }] },
          { mimeType: "application/pdf", filename: "devis.pdf", body: { attachmentId: "att-1", size: 2048 } },
          { mimeType: "message/rfc822", parts: [{ mimeType: "image/png", filename: "plan.png", body: { attachmentId: "att-2", size: 10 } }] },
          { mimeType: "text/plain", filename: "sans-identifiant.txt", body: { size: 3 } },
        ],
      },
    });
    expect(m).toMatchObject({ html: "<p>Bonjour é</p>", text: "Bonjour é", to_full: "Moi <moi@example.test>, autre@example.test", cc_full: "copie@example.test", has_attachments: true });
    expect(m.attachments).toEqual([{ id: "att-1", name: "devis.pdf", mime_type: "application/pdf", size: 2048 }, { id: "att-2", name: "plan.png", mime_type: "image/png", size: 10 }]);
  });

  test("message en texte seul ou vide", () => {
    expect(toFullMessage({ id: "m", payload: { mimeType: "text/plain", body: { data: b64("Salut") } } })).toMatchObject({ html: null, text: "Salut", attachments: [] });
    expect(toFullMessage({ id: "m" })).toMatchObject({ html: null, text: null });
  });
});

describe("HTML d'un email reçu", () => {
  test("scripts, gestionnaires, formulaires, cadres et liens dangereux retirés", () => {
    const { html } = cleanEmailHtml(
      `<title>Titre</title><p onclick="x()">Bonjour<script>alert(1)</script></p><iframe src="https://exemple.test"></iframe><form action="https://exemple.test"><input name="mdp"></form>
       <a href="javascript:alert(1)">piège</a><a href="https://exemple.test/page" onmouseover="x()">lien</a><object data="x"></object><img src="x" onerror="alert(1)">`, true);
    expect(html).not.toMatch(/<script|onclick|onerror|onmouseover|<iframe|<form|<input|<object|javascript:|alert\(|Titre/i);
    expect(html).toContain("Bonjour");
    expect(html).toContain('<a href="https://exemple.test/page" target="_blank" rel="noopener noreferrer nofollow">lien</a>');
  });

  test("images distantes masquées par défaut (pixels de suivi), affichées sur demande ; images intégrées conservées", () => {
    const src = `<img src="https://suivi.exemple.test/p.gif" alt="logo" width="1"><img src="data:image/png;base64,AAAA" alt="intégrée"><img src="http://non-chiffre.exemple.test/a.png">`;
    const off = cleanEmailHtml(src, false);
    expect(off.remote).toBe(true);
    expect(off.html).not.toContain("suivi.exemple.test");
    expect(off.html).toContain("data:image/png;base64,AAAA");
    expect(off.html).not.toContain("non-chiffre");
    const on = cleanEmailHtml(src, true);
    expect(on.html).toContain('src="https://suivi.exemple.test/p.gif"');
    expect(cleanEmailHtml("<p>texte</p>", false).remote).toBe(false);
  });

  test("mise en forme habituelle des emails conservée (tableaux, styles, couleurs)", () => {
    const { html } = cleanEmailHtml(`<style>.a{color:red}</style><table width="600" bgcolor="#fff"><tr><td style="padding:4px" align="center"><font color="#333">Offre</font></td></tr></table>`, false);
    expect(html).toContain("<style>.a{color:red}</style>");
    expect(html).toMatch(/<table width="600" bgcolor="#fff">/);
    expect(html).toMatch(/<td style="padding:4px" align="center">/);
  });
});
