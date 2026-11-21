// Boîte Gmail (lot M02) : un fil complet, lu dans Gmail à la demande (rien n'est stocké).
import type { NextRequest } from "next/server";
import { apiRead } from "@/lib/api";
import { openThread } from "@/lib/mail/box";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => openThread(sb, id, req.nextUrl.searchParams.get("images") === "1"));
}
