// Onboarding de l'offre découverte, panneau de suivi (propriétaire) : lecture, case, réglage, cibles, liens.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import * as d from "@/lib/discovery/service";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enable"), enabled: z.boolean() }),
  z.object({ op: z.literal("settings"), lemlist_invite_email: z.string().max(254) }),
  z.object({ op: z.literal("target"), position: z.number().int().min(1).max(3), data: d.targetSchema }),
  z.object({ op: z.literal("file_url"), file: z.uuid() }),
]);

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => d.discoveryAdmin(sb, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiWrite(req, async (sb) => {
    const b = body.parse(await req.json().catch(() => null));
    switch (b.op) {
      case "enable": return d.setDiscoveryEnabled(sb, id, b.enabled);
      case "settings": return d.saveDiscoverySettings(sb, { lemlist_invite_email: b.lemlist_invite_email });
      case "target": return d.saveDiscoveryTarget(sb, id, b.position, b.data);
      case "file_url": return { url: await d.discoveryFileUrl(sb, id, b.file) };
    }
  });
}
