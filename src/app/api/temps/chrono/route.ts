// Chrono en cours (pastille) et clients récents (sélecteur). Lecture légère, propriétaire uniquement.
import { apiRead } from "@/lib/api";

export async function GET() {
  return apiRead(async (sb) => {
    const [running, recent] = await Promise.all([
      sb.from("time_entries").select("id, company_id, label, started_at").is("ended_at", null).maybeSingle(),
      sb.from("time_entries").select("company_id").order("started_at", { ascending: false }).limit(60),
    ]);
    const r = running.data as { id: string; company_id: string; label: string | null; started_at: string } | null;
    const recentIds = [...new Set(((recent.data ?? []) as { company_id: string }[]).map((x) => x.company_id))].slice(0, 6);
    const ids = [...new Set([...(r ? [r.company_id] : []), ...recentIds])];
    const { data: names } = ids.length ? await sb.from("companies").select("id, name").in("id", ids) : { data: [] };
    const name = new Map(((names ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    return {
      now: new Date().toISOString(),
      running: r ? { ...r, company_name: name.get(r.company_id) ?? "Fiche supprimée" } : null,
      recent: recentIds.filter((id) => name.has(id)).map((id) => ({ id, name: name.get(id)! })),
    };
  });
}
