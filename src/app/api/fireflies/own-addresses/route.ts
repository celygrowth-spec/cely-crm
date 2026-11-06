// Adresses et domaines à traiter comme les vôtres dans le rattachement des appels.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { setOwnAddresses } from "@/lib/fireflies/reads";

const schema = z.object({
  emails: z.array(z.email("Adresse email invalide").max(254)).max(50),
  domains: z.array(z.string().min(3).max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Domaine invalide")).max(20),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    const v = schema.parse(body);
    await setOwnAddresses(sb, v.emails, v.domains);
  });
}
