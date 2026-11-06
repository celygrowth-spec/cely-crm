import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Rafraîchit la session Supabase et redirige vers /login les visiteurs non connectés.
// Le contrôle d'accès réel est fait côté serveur (requireOwner) et en base (RLS).
// /rdv et /api/rdv : réservation publique sans compte (protégée par la clé serveur et les jetons privés)
// /portail et /api/portail : portail client (session propre, vérifiée en base à chaque appel)
// /api/fireflies/webhook (signature) et /api/fireflies/cron (CRON_SECRET ou session) : appelés sans session
const PUBLIC_PATHS = ["/login", "/api/mcp", "/.well-known", "/auth", "/rdv", "/api/rdv", "/portail", "/api/portail", "/api/fireflies/webhook", "/api/fireflies/cron"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
  if (!data?.claims && !isPublic && path.startsWith("/api/")) {
    return NextResponse.json({ error: "Session expirée" }, { status: 401 });
  }
  if (!data?.claims && !isPublic) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.png|brand/|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
