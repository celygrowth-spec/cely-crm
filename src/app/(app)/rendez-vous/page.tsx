import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { overview } from "@/lib/appointments/owner";
import { DEFAULT_TZ, addDaysKey, dayKey, isoWeekday, zonedToUtc, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import { Card, EmptyState, PageHeader, ButtonLink } from "@/components/ui";
import { BookingRow } from "@/components/rdv/booking-row";
import { OpenBookingButton } from "./open-booking";

export default async function RdvOverviewPage() {
  const { supabase } = await requireOwner();
  const today = dayKey(new Date(), DEFAULT_TZ);
  const weekEndDay = addDaysKey(today, 8 - isoWeekday(today)); // lundi suivant
  const data = await overview(
    supabase,
    zonedToUtc(today, "00:00", DEFAULT_TZ).toISOString(),
    zonedToUtc(addDaysKey(today, 1), "00:00", DEFAULT_TZ).toISOString(),
    zonedToUtc(weekEndDay, "00:00", DEFAULT_TZ).toISOString(),
  );
  const n = data.next;
  return (
    <div>
      <PageHeader
        title="Rendez-vous"
        description="Réservations reçues depuis vos pages publiques."
        actions={<><ButtonLink href="/rendez-vous/types">Types et liens</ButtonLink><ButtonLink href="/rendez-vous/agenda" variant="primary">Agenda</ButtonLink></>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-1">
          <h2 className="font-label text-xs font-semibold tracking-wide text-muted uppercase">Prochain rendez-vous</h2>
          {n ? (
            <div className="mt-2">
              <p className="font-display text-lg font-bold text-ink">{formatLongDate(n.starts_at, DEFAULT_TZ)}</p>
              <p className="text-sm text-ink">{formatTimeShort(n.starts_at, DEFAULT_TZ)} – {formatTimeShort(n.ends_at, DEFAULT_TZ)} · {n.event_snapshot.name}</p>
              <p className="mt-1 text-sm text-muted">{n.first_name} {n.last_name}{(n.crm_company_name ?? n.company_name) ? ` · ${n.crm_company_name ?? n.company_name}` : ""}</p>
              <div className="mt-3 flex gap-2">
                <OpenBookingButton id={n.id} />
                {n.meeting_url && <a href={n.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center rounded-lg bg-ink px-2.5 text-xs font-semibold text-white hover:bg-violet-strong">Rejoindre</a>}
              </div>
            </div>
          ) : <p className="mt-2 text-sm text-muted">Aucun rendez-vous à venir.</p>}
        </Card>
        <Stat label="Aujourd'hui" value={data.today.length} href="/rendez-vous/agenda" />
        <Stat label="Cette semaine (après aujourd'hui)" value={data.week.length} href="/rendez-vous/agenda?vue=semaine" />
      </div>

      {data.outOfSync.length > 0 && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning">
          {data.outOfSync.length} rendez-vous pas encore répercuté(s) dans Google Agenda. <Link className="font-semibold underline" href="/parametres/connecteurs/google-agenda">Voir la connexion</Link>
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Aujourd'hui" items={data.today} empty="Rien de prévu aujourd'hui." showDate={false} />
        <Section title="À rattacher au CRM" items={data.toLink} empty="Toutes les réservations sont rattachées à une fiche." />
        <Section title="Cette semaine" items={data.week} empty="Rien d'autre cette semaine." />
        <Section title="Passés, à renseigner" items={data.toQualify} empty="Tous les rendez-vous passés sont qualifiés." />
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-line bg-white p-4 hover:border-violet">
      <p className="font-label text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-2 font-display text-3xl font-bold text-ink">{value}</p>
    </Link>
  );
}

function Section({ title, items, empty, showDate = true }: { title: string; items: Parameters<typeof BookingRow>[0]["b"][]; empty: string; showDate?: boolean }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-display text-base font-bold text-ink">{title} <span className="font-label text-xs text-muted">{items.length}</span></h2>
      {items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">{items.map((b) => <BookingRow key={b.id} b={b} showDate={showDate} />)}</ul>
      ) : (
        <EmptyState title={empty} />
      )}
    </section>
  );
}
