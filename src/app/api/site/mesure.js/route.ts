// Script de mesure d'audience chargé par celygrowth.com (<script src=".../api/site/mesure.js" async>).
// Public, sans session et sans secret. Cache court : une amélioration arrive sur le site en quelques minutes.
import { siteScript } from "@/lib/tracking/site-script";

export const dynamic = "force-static";

export function GET() {
  return new Response(siteScript(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
