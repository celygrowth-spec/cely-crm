import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { disconnectAccount, listAccounts, listRecentMail, mailConfig, sendMail, updateSignature } from "@/lib/mail/service";

export const maxDuration = 60;

export async function GET() {
  return apiRead(async (sb) => ({ configured: !!mailConfig(), accounts: await listAccounts(sb), recent: await listRecentMail(sb) }));
}

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("disconnect"), id: z.uuid() }),
  z.object({ op: z.literal("signature"), id: z.uuid(), signature: z.string() }),
  z.object({ op: z.literal("test"), to: z.string() }),
]);

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    const b = body.parse(await req.json());
    if (b.op === "disconnect") return disconnectAccount(sb, b.id);
    if (b.op === "signature") return updateSignature(sb, b.id, b.signature);
    const accounts = await listAccounts(sb);
    if (!accounts.some((a) => a.is_default && a.status === "connected")) throw new CrmError("Connectez d'abord un compte Gmail.");
    return sendMail(sb, {
      to: [b.to.trim()],
      subject: "Test d'envoi depuis Cely CRM",
      text: "Ce message confirme que votre compte Gmail peut envoyer des emails depuis Cely CRM.\n\nAucune action n'est nécessaire.",
      origin: "system",
      business: { type: "mail_test", id: crypto.randomUUID() },
    });
  });
}
