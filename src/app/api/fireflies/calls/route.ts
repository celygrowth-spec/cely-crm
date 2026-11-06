// Appels d'une fiche (?company=) ou d'un rendez-vous (?booking=), plus récents en premier, sans transcription.
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRead } from "@/lib/api";
import { listCalls } from "@/lib/fireflies/reads";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const company = z.uuid().safeParse(u.get("company"));
  const booking = z.uuid().safeParse(u.get("booking"));
  if (!company.success && !booking.success) return NextResponse.json({ error: "Paramètre invalide" }, { status: 400 });
  return apiRead((sb) => listCalls(sb, company.success ? { company: company.data } : { booking: booking.data }));
}
