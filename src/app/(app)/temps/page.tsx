// Temps passé par client sur une période (Europe/Paris). S'ouvre sur « Cette semaine ».
import { requireAppOwner } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { periodOf, todayParis, type TimeEntry } from "@/lib/time/calc";
import { TempsView } from "./temps-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | undefined>>;
const COLS = "id, company_id, label, started_at, ended_at, source";
type Raw = Omit<TimeEntry, "company_name">;

export default async function TempsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { supabase } = await requireAppOwner();
  const today = todayParis();
  const period = periodOf(sp.p, today, sp.du, sp.au);
  // sessions qui recoupent la période (une session dure 7 jours au plus) et chrono en cours
  const [rows, one] = await Promise.all([
    supabase.from("time_entries").select(COLS)
      .gte("started_at", new Date(period.start - 7 * 864e5).toISOString()).lt("started_at", new Date(period.end).toISOString())
      .order("started_at", { ascending: false }).limit(2000),
    sp.session && /^[0-9a-f-]{36}$/.test(sp.session) ? supabase.from("time_entries").select(COLS).eq("id", sp.session).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (rows.error) throw new CrmError(friendlyError(rows.error));
  const raw = [...((rows.data ?? []) as Raw[]), ...(one.data ? [one.data as Raw] : [])];
  const ids = [...new Set(raw.map((r) => r.company_id))];
  const { data: names } = ids.length ? await supabase.from("companies").select("id, name").in("id", ids) : { data: [] };
  const name = new Map(((names ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const map = (r: Raw): TimeEntry => ({ ...r, company_name: name.get(r.company_id) ?? "Fiche supprimée" });
  const entries = ((rows.data ?? []) as Raw[]).map(map).filter((e) => !e.ended_at || Date.parse(e.ended_at) > period.start);
  return (
    <TempsView
      period={period}
      today={today}
      entries={entries}
      focus={one.data ? map(one.data as Raw) : null}
      openClient={sp.client ?? null}
    />
  );
}
