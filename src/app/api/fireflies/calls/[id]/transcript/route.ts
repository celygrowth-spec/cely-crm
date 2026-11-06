// Transcription complète, chargée à l'ouverture du détail. Propriétaire uniquement (RLS), jamais en cache partagé.
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRead } from "@/lib/api";
import { getTranscript } from "@/lib/fireflies/reads";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return NextResponse.json({ error: "Paramètre invalide" }, { status: 400 });
  return apiRead((sb) => getTranscript(sb, parsed.data));
}
