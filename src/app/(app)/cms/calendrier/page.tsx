// CMS › Calendrier éditorial : articles datés, par mois, à l'heure de Paris (heure d'été comprise).
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, PageHeader } from "@/components/ui";
import { requireAppOwner } from "@/lib/auth";
import { cmsMissingTables } from "@/lib/cms/ready";
import { CmsNotInstalled } from "@/components/cms/not-installed";
import { addMonthsKey, formatTimeShort, monthGrid, monthLabel } from "@/lib/appointments/time";
import { CMS_TZ, parisDay } from "@/lib/cms/dates";
import { listEntries, promoteDue } from "@/lib/cms/service";
import { STATUS_LABEL, STATUS_TONE, effectiveStatus } from "@/lib/cms/types";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";
const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  const { mois } = await searchParams;
  const { supabase } = await requireAppOwner();
  if (await cmsMissingTables(supabase)) return <CmsNotInstalled />;
  await promoteDue(supabase).catch(() => 0);
  const today = parisDay(new Date());
  const month = mois && /^\d{4}-(0[1-9]|1[0-2])$/.test(mois) ? mois : today.slice(0, 7);
  const entries = (await listEntries(supabase)).filter((e) => e.publish_at && parisDay(e.publish_at).startsWith(month));
  const byDay = new Map<string, typeof entries>();
  for (const e of entries.sort((a, b) => a.publish_at!.localeCompare(b.publish_at!))) {
    const k = parisDay(e.publish_at!);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const nav = (n: number) => `/cms/calendrier?mois=${addMonthsKey(month, n)}`;
  return (
    <div className="mx-auto max-w-6xl" data-cms-calendar>
      <PageHeader title="Calendrier éditorial" description="Publications par jour, heure de Paris. Les articles non datés sont dans la liste des articles." />
      <div className="mb-3 flex items-center gap-2">
        <Link href={nav(-1)} className="rounded-lg border border-line bg-white p-1.5 hover:border-violet" aria-label="Mois précédent"><ChevronLeft size={16} /></Link>
        <h2 className="min-w-44 text-center font-display text-lg font-bold" data-month={month}>{monthLabel(month)}</h2>
        <Link href={nav(1)} className="rounded-lg border border-line bg-white p-1.5 hover:border-violet" aria-label="Mois suivant"><ChevronRight size={16} /></Link>
        {month !== today.slice(0, 7) && <Link href="/cms/calendrier" className="ml-2 text-sm font-semibold text-violet-strong hover:underline">Aujourd&apos;hui</Link>}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[44rem] grid-cols-7 gap-px overflow-hidden rounded-xl border border-line bg-line">
          {DAYS.map((d) => <div key={d} className="bg-surface px-2 py-1 font-label text-xs font-semibold text-muted">{d}</div>)}
          {monthGrid(month).map((day, i) => (
            <div key={day ?? `x${i}`} className={cn("min-h-24 bg-white p-1.5", !day && "bg-surface/50")} data-day={day ?? undefined}>
              {day && <div className={cn("mb-1 text-xs font-semibold", day === today ? "inline-block rounded-full bg-ink px-1.5 text-white" : "text-muted")}>{Number(day.slice(8))}</div>}
              {day && (byDay.get(day) ?? []).map((e) => {
                const s = effectiveStatus(e);
                return (
                  <Link key={e.id} href={`/cms/articles/${e.id}`} className="mb-1 block rounded-md border border-line px-1.5 py-1 text-xs hover:border-violet" data-cal-entry={e.slug}>
                    <span className="block truncate font-semibold">{formatTimeShort(e.publish_at!, CMS_TZ)} · {e.title}</span>
                    <Badge tone={STATUS_TONE[s]} className="mt-0.5">{STATUS_LABEL[s]}</Badge>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
