import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";
import { exchangeCode } from "@/lib/mail/google";
import { mailConfig, saveConnection } from "@/lib/mail/service";

export async function GET(req: NextRequest) {
  const { supabase } = await requireAppOwner();
  const origin = req.nextUrl.origin;
  const done = (q: string) => {
    const res = NextResponse.redirect(`${origin}/mail?${q}`);
    res.cookies.delete({ name: "mail_oauth", path: "/api/mail/oauth" });
    return res;
  };
  const c = mailConfig();
  if (!c) return done("error=config");
  const q = req.nextUrl.searchParams;
  const [expected, verifier] = (req.cookies.get("mail_oauth")?.value ?? "").split(".");
  const state = Buffer.from(q.get("state") ?? "");
  if (!expected || !verifier || state.length !== Buffer.byteLength(expected) || !timingSafeEqual(state, Buffer.from(expected))) return done("error=state");
  if (q.get("error")) return done("error=denied");
  const code = q.get("code");
  if (!code) return done("error=denied");
  try {
    const tokens = await exchangeCode(c, { code, redirectUri: `${origin}/api/mail/oauth/callback`, verifier });
    await saveConnection(supabase, tokens);
    return done("connected=1");
  } catch (e) {
    // des codes, pas de texte libre : l'adresse de la page ne doit pas pouvoir afficher n'importe quel message
    const text = e instanceof CrmError ? e.message : "";
    return done(`error=${/autorisation/.test(text) ? "scope" : /durable/.test(text) ? "refresh" : "failed"}`);
  }
}
