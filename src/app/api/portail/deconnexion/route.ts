import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { PORTAL_COOKIE, sessionHash } from "@/lib/projects/portal-auth";
import { reply, sameOrigin } from "@/lib/projects/portal-http";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const token = req.cookies.get(PORTAL_COOKIE)?.value;
  if (token) await publicClient().rpc("portal_logout", { p_server_key: serverRpcKey(), p_session_hash: sessionHash(token) }).then(() => undefined, () => undefined);
  const res = reply({ ok: true });
  res.cookies.set(PORTAL_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true });
  return res;
}
