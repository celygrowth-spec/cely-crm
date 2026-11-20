// Lectures de l'espace Tracking site : agrégats calculés en base, réservés au propriétaire (apiRead + RLS).
import { z } from "zod";
import { apiRead } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { CHANNELS } from "@/lib/tracking/sources";

const REPORTS: Record<string, string> = {
  overview: "site_stats_overview", sources: "site_stats_sources", campaigns: "site_stats_campaigns", pages: "site_stats_pages",
  prospects: "site_stats_prospects", seo: "site_stats_seo", ai: "site_stats_ai", geo: "site_stats_geo",
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)));
const text = (max: number) => z.string().trim().min(1).max(max).optional();
const query = z.object({
  from: day, to: day,
  channel: z.enum(CHANNELS).optional(), source: text(120), campaign: text(120), page: text(300), query: text(300),
  country: z.string().regex(/^[A-Z]{2}$/).optional(), device: z.enum(["desktop", "mobile", "tablet"]).optional(),
  provider: z.enum(["gsc", "bing"]).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return apiRead(async (sb) => {
    const call = async (fn: string, args?: Record<string, unknown>) => {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new CrmError("Données momentanément indisponibles.");
      return data;
    };
    if (report === "live") return call("site_live");
    if (report === "options") return call("site_filter_options");
    const raw = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    const parsed = query.safeParse(raw);
    if (!parsed.success) throw new CrmError("Période ou filtre invalide.");
    const { from, to, ...filters } = parsed.data;
    // treize mois au plus par requête, bornes dans l'ordre
    if (from > to || Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw new CrmError("Période invalide (13 mois au plus).");
    if (report === "recommendations") return call("site_recommendations", { p_from: from, p_to: to });
    const fn = REPORTS[report];
    if (!fn) throw new CrmError("Rapport inconnu.");
    return call(fn, { p_from: from, p_to: to, p_f: filters });
  });
}
