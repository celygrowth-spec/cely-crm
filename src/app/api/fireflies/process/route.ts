// Traite les imports dus sans attendre le passage quotidien : propriétaire uniquement.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { publicClient } from "@/lib/appointments/server";
import { assertOwnerSession } from "@/lib/fireflies/reads";
import { drainImports } from "@/lib/fireflies/worker";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    await assertOwnerSession(sb);
    return drainImports(publicClient());
  });
}
