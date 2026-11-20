"use client";

// Sources : répartition et évolution de chaque source, rendez-vous en première et en dernière source,
// détail des sites référents, comparaison entre source mesurée et source déclarée.
import { CHANNEL_ORDER, channelLabel, channelVar, sourceName } from "@/lib/tracking/channels";
import { DECLARED_CHANNEL, type DeclaredSource } from "@/lib/tracking/declared";
import { cn } from "@/components/ui";
import { BarList, ChannelChip, ChannelDot, DataTable, Delta, ErrorNote, Legend, Panel, TabSkeleton, share, type Column } from "./bits";
import { Lines, type Point } from "./charts-lazy";
import { addDays, num, percent, rate, useReport, type TrackingState } from "./state";
import type { SourcesReport } from "./types";

type Ch = SourcesReport["channels"][number];
type Detail = SourcesReport["details"][number];
type Ref = SourcesReport["referrers"][number];

export function SourcesTab({ s }: { s: TrackingState }) {
  const { data, loading, stale, error, refetch } = useReport<SourcesReport>("sources", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  const channels = CHANNEL_ORDER.map((c) => data.channels.find((x) => x.channel === c)!).filter((c) => c && (c.visits > 0 || c.previous_visits > 0 || c.bookings_first > 0));
  const total = channels.reduce((n, c) => n + c.visits, 0);
  const toggle = (c: string) => s.setFilter("channel", s.filters.channel === c ? null : c);
  // huit courbes au jour le jour sont illisibles au-delà d'un mois : elles sont regroupées par semaine
  const weekly = data.series.bucket === "day" && data.series.points.length > 45;
  const bucket = weekly ? "week" : data.series.bucket;
  const daily: Point[] = data.series.points.map((p) => ({ d: p.d, ...Object.fromEntries(CHANNEL_ORDER.map((c) => [c, p.by[c] ?? 0])) }));
  const points: Point[] = !weekly ? daily : daily.reduce<Point[]>((acc, p, i) => {
    if (i % 7 === 0) acc.push({ ...p });
    else { const w = acc[acc.length - 1]; for (const c of CHANNEL_ORDER) w[c] = Number(w[c] ?? 0) + Number(p[c] ?? 0); }
    return acc;
  }, []);
  const series = channels.filter((c) => c.visits > 0).map((c) => ({ key: c.channel, label: channelLabel(c.channel), color: channelVar(c.channel) }));
  const pick = (d: string) => s.set({ du: d, au: bucket === "week" ? (addDays(d, 6) > s.to ? s.to : addDays(d, 6)) : d, periode: null });

  const cols: Column<Ch>[] = [
    { key: "c", label: "Source", render: (r) => <span className="inline-flex items-center gap-2 font-semibold"><ChannelDot channel={r.channel} />{channelLabel(r.channel)}</span> },
    { key: "v", label: "Visites", align: "right", render: (r) => num(r.visits) },
    { key: "p", label: "Part", align: "right", render: (r) => share(r.visits, total) },
    { key: "d", label: "Évolution", align: "right", render: (r) => <Delta current={r.visits} previous={r.previous_visits} /> },
    { key: "u", label: "Visiteurs", align: "right", render: (r) => num(r.visitors) },
    { key: "f", label: "RDV · 1re source", align: "right", render: (r) => num(r.bookings_first) },
    { key: "l", label: "RDV · dernière source", align: "right", render: (r) => num(r.bookings_last) },
    { key: "t", label: "Taux", align: "right", render: (r) => percent(rate(r.bookings_last, r.visits), 2) },
  ];
  const detailCols: Column<Detail>[] = [
    { key: "s", label: "Détail", render: (r) => <ChannelChip channel={r.channel} detail={sourceName(r.source) || "sans détail"} /> },
    { key: "v", label: "Visites", align: "right", render: (r) => num(r.visits) },
    { key: "f", label: "RDV · première", align: "right", render: (r) => num(r.bookings_first) },
    { key: "l", label: "RDV · dernière", align: "right", render: (r) => num(r.bookings_last) },
  ];
  const refCols: Column<Ref>[] = [
    { key: "h", label: "Site référent", render: (r) => <span className="font-semibold">{r.host}</span> },
    { key: "v", label: "Visites", align: "right", render: (r) => num(r.visits) },
    { key: "u", label: "Visiteurs", align: "right", render: (r) => num(r.visitors) },
    { key: "b", label: "Rendez-vous", align: "right", render: (r) => num(r.bookings) },
  ];

  // source déclarée (lignes) contre première source mesurée (colonnes)
  const declaredRows = [...new Set(data.declared.map((d) => d.declared))].sort((a, b) => (a === "Non renseignée" ? 1 : b === "Non renseignée" ? -1 : 0));
  const measuredCols = [...CHANNEL_ORDER.filter((c) => data.declared.some((d) => d.measured === c)), ...(data.declared.some((d) => d.measured === "unknown") ? ["unknown"] : [])];
  const cell = (d: string, m: string) => data.declared.find((x) => x.declared === d && x.measured === m)?.n ?? 0;
  const answered = data.declared.filter((d) => d.declared !== "Non renseignée");
  const agree = answered.filter((d) => DECLARED_CHANNEL[d.declared as DeclaredSource] === d.measured).reduce((n, d) => n + d.n, 0);
  const comparable = answered.filter((d) => DECLARED_CHANNEL[d.declared as DeclaredSource]).reduce((n, d) => n + d.n, 0);

  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="Répartition" hint="Part des visites par source. Clique une source pour filtrer tout l'espace.">
          <BarList onPick={toggle} items={channels.filter((c) => c.visits > 0).sort((a, b) => b.visits - a.visits).map((c) => ({
            key: c.channel, label: channelLabel(c.channel), value: c.visits, sub: share(c.visits, total), color: channelVar(c.channel),
          }))} empty="Aucune visite sur cette période avec ces filtres." />
        </Panel>
        <Panel title="Évolution de chaque source" hint={bucket === "week" ? "Visites par semaine." : "Visites par jour."}>
          {total === 0 ? <p className="py-16 text-center text-sm text-muted">Aucune visite sur cette période avec ces filtres.</p> : (
            <>
              <Lines points={points} series={series} bucket={bucket} label="Évolution des visites de chaque source" onPickPoint={pick} />
              <div className="mt-3"><Legend items={series.map((x) => ({ key: x.key, label: x.label, color: x.color }))} active={s.filters.channel ?? null} onPick={toggle} /></div>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Rendez-vous et taux de conversion par source"
        hint="Première source : le premier contact du prospect. Dernière source : la visite pendant laquelle il a réservé.">
        <DataTable rows={channels} columns={cols} rowKey={(r) => r.channel} onRow={(r) => toggle(r.channel)} rowTitle={(r) => `Filtrer sur ${channelLabel(r.channel)}`} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Détail par source" hint="Moteur, réseau, IA ou campagne à l'origine des visites.">
          <DataTable rows={data.details} columns={detailCols} rowKey={(r) => `${r.channel}:${r.source}`} limit={14}
            onRow={(r) => s.set({ channel: r.channel, source: r.source || null })} rowTitle={() => "Filtrer sur cette source"} />
        </Panel>
        <Panel title="Sites référents" hint="Autres sites qui envoient des visiteurs, hors moteurs, réseaux et IA.">
          <DataTable rows={data.referrers} columns={refCols} rowKey={(r) => r.host} limit={14}
            onRow={(r) => s.set({ channel: "referral", source: r.host })} rowTitle={() => "Filtrer sur ce site"}
            empty="Aucun site référent sur la période. Un lien depuis un partenaire, un annuaire ou un article apparaîtra ici." />
        </Panel>
      </div>

      <Panel title="Source mesurée et source déclarée"
        hint="Ce que répondent les prospects à « Comment m'avez-vous connu ? », comparé à leur première source mesurée.">
        {data.bookings === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Aucun rendez-vous sur la période : la comparaison apparaît dès qu&apos;un prospect réserve.</p>
        ) : (
          <>
            {comparable > 0 && (
              <p className="mb-3 text-sm text-ink">
                <strong>{percent(rate(agree, comparable), 0)}</strong> des réponses comparables correspondent à la source mesurée
                <span className="text-muted"> ({num(agree)} sur {num(comparable)}). Un écart signale souvent du bouche-à-oreille ou un premier contact hors du site.</span>
              </p>
            )}
            <div className="-mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="px-4 py-2 text-left font-label text-[11px] font-bold tracking-wide text-muted uppercase sm:px-5">Déclarée ↓ · Mesurée →</th>
                    {measuredCols.map((m) => (
                      <th key={m} scope="col" className="px-2 py-2 text-right text-xs font-semibold whitespace-nowrap text-ink">
                        {m === "unknown" ? "Non mesurée" : <span className="inline-flex items-center gap-1.5"><ChannelDot channel={m} />{channelLabel(m)}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {declaredRows.map((d) => (
                    <tr key={d} className="border-b border-line/60 last:border-0">
                      <th scope="row" className={cn("px-4 py-2 text-left font-semibold sm:px-5", d === "Non renseignée" && "font-normal text-muted")}>{d}</th>
                      {measuredCols.map((m) => {
                        const n = cell(d, m);
                        const same = DECLARED_CHANNEL[d as DeclaredSource] === m;
                        return (
                          <td key={m} className="px-2 py-2 text-right tabular-nums">
                            {n > 0
                              ? <span className={cn("inline-block min-w-8 rounded-md px-2 py-0.5", same ? "bg-violet-soft font-bold text-ink" : "text-ink")} title={same ? "Déclaration et mesure concordent" : undefined}>{num(n)}</span>
                              : <span className="text-muted">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
