// Boîte Gmail (lot M01) : état de la synchronisation (GET) et passage immédiat (POST), réservés au propriétaire.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { ensureServerKey } from "@/lib/appointments/owner";
import { CrmError } from "@/lib/crm/service";
import { boiteJob, runJob } from "@/lib/jobs/run";
import { boxStatus } from "@/lib/mail/box";

export const maxDuration = 60;

export async function GET() {
  return apiRead((sb) => boxStatus(sb));
}

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    // la synchronisation écrit avec la clé serveur : le droit du demandeur est vérifié ici, pas seulement par l'interface
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé");
    if (!(await ensureServerKey(sb))) throw new CrmError("La synchronisation de la boîte demande la variable serveur APPOINTMENTS_SECRET (voir docs/mail-configuration.md).");
    // l'issue (succès ou erreur) est enregistrée en base : l'état renvoyé la reflète
    const run = await runJob("boite", (server) => boiteJob(server, { budgetMs: 25_000 }));
    const status = await boxStatus(sb);
    if (!run.ok && status.state !== "error") return { ...status, state: "error" as const, message: "La synchronisation n'a pas pu démarrer. Elle sera retentée automatiquement." };
    return status;
  });
}
