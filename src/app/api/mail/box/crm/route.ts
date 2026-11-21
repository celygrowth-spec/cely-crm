// Boîte Gmail (lot M05) : fiches du CRM correspondant aux adresses d'un fil.
import type { NextRequest } from "next/server";
import { apiRead } from "@/lib/api";
import { crmContext } from "@/lib/mail/box";

export async function GET(req: NextRequest) {
  return apiRead((sb) => crmContext(sb, (req.nextUrl.searchParams.get("emails") ?? "").split(",")));
}
