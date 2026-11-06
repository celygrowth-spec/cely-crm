// Recalcule les appels à rattacher, sans attendre le passage quotidien. Propriétaire uniquement.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { rematchAsOwner } from "@/lib/fireflies/links";

export async function POST(req: NextRequest) {
  return apiWrite(req, rematchAsOwner);
}
