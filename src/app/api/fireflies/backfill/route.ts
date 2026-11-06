// Import historique sur une période choisie (un an au maximum) : les appels déjà connus ne sont pas repris.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { publicClient } from "@/lib/appointments/server";
import { CrmError } from "@/lib/crm/service";
import { FirefliesFailure } from "@/lib/fireflies/client";
import { assertOwnerSession } from "@/lib/fireflies/reads";
import { backfillRange } from "@/lib/fireflies/worker";

export const maxDuration = 60;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const schema = z
  .object({ from: z.string().regex(DAY, "Date de début invalide"), to: z.string().regex(DAY, "Date de fin invalide") })
  .transform((v) => ({ from: new Date(`${v.from}T00:00:00.000Z`), to: new Date(`${v.to}T23:59:59.999Z`) }))
  .refine((v) => !Number.isNaN(v.from.getTime()) && !Number.isNaN(v.to.getTime()) && v.from <= v.to, "Période invalide")
  .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 86_400_000, "Choisissez une période d'un an au maximum");

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    const { from, to } = schema.parse(body);
    await assertOwnerSession(sb);
    try {
      return await backfillRange(publicClient(), from, to);
    } catch (e) {
      if (e instanceof FirefliesFailure) throw new CrmError(e.message); // nos messages, jamais ceux de l'API
      throw e;
    }
  });
}
