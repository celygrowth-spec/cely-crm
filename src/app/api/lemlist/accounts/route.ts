// Comptes lemlist des clients (Connecteurs › lemlist clients). Propriétaire uniquement.
// La clé API arrive ici une seule fois (ajout ou reconnexion), est testée chez lemlist puis chiffrée :
// aucune réponse ne la renvoie, aucun journal ne l'écrit.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { connectLemlistAccount, disconnectLemlistAccount, lemlistTokenKey, listClientOptions, listLemlistAccounts, verifyLemlistAccount } from "@/lib/lemlist/accounts";
import type { LemlistOverview } from "@/lib/lemlist/types";

export const maxDuration = 30;

export async function GET() {
  return apiRead(async (sb): Promise<LemlistOverview> => {
    const [accounts, clients] = await Promise.all([listLemlistAccounts(sb), listClientOptions(sb)]);
    return { configured: !!lemlistTokenKey(), accounts, clients };
  });
}

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("connect"), companyId: z.string(), apiKey: z.string() }),
  z.object({ op: z.literal("disconnect"), id: z.uuid() }),
  z.object({ op: z.literal("verify"), id: z.uuid() }),
]);

async function requireOwner(sb: SupabaseClient) {
  const { data } = await sb.rpc("is_app_owner");
  if (data !== true) throw new CrmError("Accès refusé.");
}

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    await requireOwner(sb);
    const b = body.parse(await req.json());
    if (b.op === "connect") return connectLemlistAccount(sb, { companyId: b.companyId, apiKey: b.apiKey });
    if (b.op === "disconnect") return disconnectLemlistAccount(sb, b.id);
    return verifyLemlistAccount(sb, b.id);
  });
}
