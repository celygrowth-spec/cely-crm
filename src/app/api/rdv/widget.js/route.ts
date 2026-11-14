// Script d'intégration des pages de réservation, chargé par les sites des clients (<script src=".../api/rdv/widget.js">).
// Public, sans session et sans secret. Cache court : une amélioration arrive sur les sites en quelques minutes,
// sans nouveau copier-coller.
import { widgetScript } from "@/lib/appointments/widget-script";

export const dynamic = "force-static";

export function GET() {
  return new Response(widgetScript(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      // chargeable depuis n'importe quel site, y compris ceux qui isolent leurs ressources (COEP)
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
