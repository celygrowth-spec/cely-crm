// Réception Gmail (Q03) : lecture d'un message, citation retirée, messages automatiques, pièces jointes (métadonnées).
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { addressOf, parseGmailMessage, stripQuoted, type GmailPart } from "@/lib/mail/inbound";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const msg = (headers: Record<string, string>, parts: GmailPart[], labelIds: string[] = ["INBOX"]) => ({
  id: "g1", threadId: "t1", internalDate: String(Date.parse("2026-11-10T09:00:00Z")), labelIds,
  payload: { mimeType: "multipart/mixed", headers: Object.entries(headers).map(([name, value]) => ({ name, value })), parts },
});

describe("lecture d'un email reçu", () => {
  test("expéditeur, destinataires, texte sans la citation, pièce jointe sans contenu", () => {
    const m = parseGmailMessage(msg({ From: "Claire Martin <Claire@Studio.example.test>", To: "moi@example.test", Cc: "\"Doe, J\" <j@x.test>", Subject: "Re: Proposition", "Message-ID": "<abc@mail>" }, [
      { mimeType: "text/plain", body: { data: b64("Bonjour,\nC'est d'accord pour jeudi.\n\nLe lun. 9 nov. 2026 à 10:00, Moi <moi@example.test> a écrit :\n> Proposition") } },
      { mimeType: "application/pdf", filename: "devis.pdf", body: { attachmentId: "a1", size: 1200 } },
    ]));
    expect(m).toMatchObject({ from: "claire@studio.example.test", to: ["moi@example.test", "j@x.test"], subject: "Re: Proposition", rfc_message_id: "<abc@mail>", automatic: false,
      text: "Bonjour,\nC'est d'accord pour jeudi.", received_at: "2026-11-10T09:00:00.000Z", attachments: [{ name: "devis.pdf", mime_type: "application/pdf", size: 1200 }] });
  });
  test("HTML seul : converti en texte", () => {
    expect(parseGmailMessage(msg({ From: "a@b.test" }, [{ mimeType: "text/html", body: { data: b64("<p>Oui&nbsp;!</p><br>Merci") } }])).text).toBe("Oui !\n\nMerci");
  });
  test("réponses automatiques, listes, noreply, promotions : automatiques", () => {
    expect(parseGmailMessage(msg({ From: "a@b.test", "Auto-Submitted": "auto-replied" }, [])).automatic).toBe(true);
    expect(parseGmailMessage(msg({ From: "a@b.test", "List-Id": "<news.b.test>" }, [])).automatic).toBe(true);
    expect(parseGmailMessage(msg({ From: "no-reply@b.test" }, [])).automatic).toBe(true);
    expect(parseGmailMessage(msg({ From: "a@b.test" }, [], ["INBOX", "CATEGORY_PROMOTIONS"])).automatic).toBe(true);
    expect(parseGmailMessage(msg({ From: "a@b.test", "Auto-Submitted": "no" }, [])).automatic).toBe(false);
  });
  test("adresses et citations", () => {
    expect(addressOf("pas une adresse")).toBeNull();
    expect(stripQuoted("Ok\n\nOn Mon, Nov 9, 2026 at 10:00 AM Moi <m@x.test> wrote:\n> old")).toBe("Ok");
  });
});
