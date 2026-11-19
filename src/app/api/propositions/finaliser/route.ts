// Signatures reçues de Make pendant l'absence du propriétaire : à son retour, chaque proposition signée passe en
// client par la logique existante (une seule fois), ou reste « à confirmer » avec la raison.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { finalizePending } from "@/lib/proposals/signature";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return apiWrite(req, (sb) => finalizePending(sb));
}
