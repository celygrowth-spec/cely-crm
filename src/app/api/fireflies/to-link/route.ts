// File « Appels à rattacher », ou appels ignorés avec ?state=ignored : propriétaire uniquement.
import { apiRead } from "@/lib/api";
import { listCalls } from "@/lib/fireflies/reads";

export async function GET(req: Request) {
  const state = new URL(req.url).searchParams.get("state") === "ignored" ? "ignored" : "to_link";
  return apiRead((sb) => listCalls(sb, { state }));
}
