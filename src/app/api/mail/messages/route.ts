import type { NextRequest } from "next/server";
import { apiRead } from "@/lib/api";
import { listCompanyMail } from "@/lib/mail/service";

export async function GET(req: NextRequest) {
  return apiRead((sb) => listCompanyMail(sb, req.nextUrl.searchParams.get("company") ?? ""));
}
