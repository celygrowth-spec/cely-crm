// Boîte Gmail (lot M02) : une page de fils d'un dossier (index), ou d'une recherche (syntaxe Gmail, faite par Gmail).
import type { NextRequest } from "next/server";
import { apiRead } from "@/lib/api";
import { listThreads, searchThreads } from "@/lib/mail/box";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = p.get("q")?.trim();
  return apiRead((sb) => (q ? searchThreads(sb, q, p.get("page")) : listThreads(sb, p.get("label") ?? "INBOX", p.get("page"))));
}
