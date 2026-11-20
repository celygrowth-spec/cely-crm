"use client";

// SEO : mots-clés Google et Bing (clics, impressions, position et tendance), courbe de position par mot-clé,
// rapprochement entre mots-clés, pages et rendez-vous. Les données viennent des connecteurs Search Console et Bing.
import { useSearchParams } from "next/navigation";
import { ArrowDownRight, ArrowUpRight, Minus, Search, X } from "lucide-react";
import { cn } from "@/components/ui";
import { channelVar } from "@/lib/tracking/channels";
import { DataTable, Delta, Empty, ErrorNote, Legend, Panel, TabSkeleton, type Column } from "./bits";
import { Lines, StackedArea, type Point } from "./charts-lazy";
import { num, percent, rate, short, useReport, type TrackingState } from "./state";
import type { SeoReport } from "./types";

type Query = SeoReport["queries"][number];
type PageRow = SeoReport["pages"][number];
const ENGINE = { gsc: "Google", bing: "Bing" } as const;
const ENGINE_COLOR: Record<string, string> = { gsc: channelVar("direct"), bing: channelVar("campaign") };
const pos = (p: number | null) => (p == null ? "–" : p.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

/** Tendance de position : monter (un chiffre plus petit) est une bonne nouvelle. Flèche + valeur, jamais la couleur seule. */
function PositionTrend({ current, previous }: { current: number | null; previous: number | null }) {
  if (current == null || previous == null) return <span className="text-xs text-muted">nouveau</span>;
  const diff = previous - current;
  if (Math.abs(diff) < 0.3) return <span className="inline-flex items-center gap-0.5 text-xs text-muted"><Minus size={12} aria-hidden /> stable</span>;
  const up = diff > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-semibold" style={{ color: up ? "var(--trk-up)" : "var(--trk-down)" }} title={`Période précédente : position ${pos(previous)}`}>
      <Icon size={13} aria-hidden /> {up ? "gagne" : "perd"} {Math.abs(diff).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}
    </span>
  );
}

export function SeoTab({ s }: { s: TrackingState }) {
  const sp = useSearchParams();
  const provider = sp.get("moteur") === "gsc" || sp.get("moteur") === "bing" ? sp.get("moteur")! : undefined;
  const query = sp.get("q") ?? undefined;
  const { data, loading, stale, error, refetch } = useReport<SeoReport>("seo", s, { provider, query });
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;

  const broken = data.connections.filter((c) => c.status !== "connected");
  const notice = broken.length > 0 && (
    <div role="alert" className="trk-card flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
      <span className="text-ink">
        {broken.map((c) => (c.provider === "gsc" ? "Google Search Console" : "Bing Webmaster Tools")).join(" et ")} {broken.length > 1 ? "sont à reconnecter" : "est à reconnecter"} :
        les mots-clés ne sont plus mis à jour. Les autres données continuent d&apos;arriver.
      </span>
      <a href="/parametres/connecteurs" className="font-semibold text-violet-strong hover:underline">Ouvrir Connecteurs</a>
    </div>
  );
  if (!data.has_data) {
    return (
      <div className="grid gap-4">
        {notice}
        <Empty icon={<Search size={20} />} title={data.connections.length ? "Les mots-clés arrivent" : "Branche Search Console dans Connecteurs"} action={{ href: "/parametres/connecteurs", label: "Ouvrir Connecteurs" }}>
          {data.connections.length
            ? "La première synchronisation importe tout l'historique disponible. Elle avance par lots : reviens dans quelques minutes, ou lance « Synchroniser maintenant » dans Connecteurs."
            : "Connecte Google Search Console et Bing Webmaster Tools (lecture seule) pour voir les mots-clés qui amènent des visites, leur position et les pages qui en profitent."}
        </Empty>
      </div>
    );
  }

  const t = data.totals;
  const engines = (["gsc", "bing"] as const).filter((e) => data.series.points.some((p) => (p.by[e] ?? 0) > 0));
  const points: Point[] = data.series.points.map((p) => ({ d: p.d, gsc: p.by.gsc ?? 0, bing: p.by.bing ?? 0 }));
  const series = engines.map((e) => ({ key: e, label: ENGINE[e], color: ENGINE_COLOR[e] }));
  const posPoints: Point[] = data.positions.map((p) => ({ d: p.d, gsc: p.by.gsc ?? null, bing: p.by.bing ?? null }));
  const posSeries = (["gsc", "bing"] as const).filter((e) => data.positions.some((p) => p.by[e] != null)).map((e) => ({ key: e, label: ENGINE[e], color: ENGINE_COLOR[e] }));
  const setQuery = (q: string | null) => s.set({ q });

  const cols: Column<Query>[] = [
    { key: "q", label: "Mot-clé", className: "max-w-[17rem]", render: (r) => <span className={cn("block truncate font-semibold", query === r.query && "text-violet-strong")}>{r.query}</span> },
    { key: "e", label: "Moteur", render: (r) => <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: ENGINE_COLOR[r.provider] }} aria-hidden />{ENGINE[r.provider as "gsc" | "bing"] ?? r.provider}</span> },
    { key: "c", label: "Clics", align: "right", render: (r) => num(r.clicks) },
    { key: "i", label: "Impressions", align: "right", render: (r) => num(r.impressions) },
    { key: "t", label: "Taux de clic", align: "right", render: (r) => percent(r.ctr) },
    { key: "p", label: "Position", align: "right", render: (r) => pos(r.position) },
    { key: "d", label: "Tendance", align: "right", render: (r) => <PositionTrend current={r.position} previous={r.previous_position} /> },
    { key: "g", label: "Page", className: "max-w-[12rem]", render: (r) => (r.page ? <span className="block truncate text-muted">{r.page}</span> : <span className="text-muted">–</span>) },
    { key: "b", label: "RDV de la page", align: "right", render: (r) => (r.page_bookings == null ? <span className="text-muted">–</span> : num(r.page_bookings)) },
  ];
  const pageCols: Column<PageRow>[] = [
    { key: "p", label: "Page", className: "max-w-[20rem]", render: (r) => <span className={cn("block truncate font-semibold", s.filters.page === r.page && "text-violet-strong")}>{r.page}</span> },
    { key: "e", label: "Moteur", render: (r) => ENGINE[r.provider as "gsc" | "bing"] ?? r.provider },
    { key: "k", label: "Mots-clés", align: "right", render: (r) => num(r.queries) },
    { key: "c", label: "Clics", align: "right", render: (r) => num(r.clicks) },
    { key: "i", label: "Impressions", align: "right", render: (r) => num(r.impressions) },
    { key: "o", label: "Position", align: "right", render: (r) => pos(r.position) },
    { key: "v", label: "Visites mesurées", align: "right", render: (r) => num(r.visits) },
    { key: "b", label: "Rendez-vous", align: "right", render: (r) => num(r.bookings) },
  ];

  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      {notice}
      <div className="flex flex-wrap items-center gap-2">
        <div className="trk-card flex items-center gap-0.5 p-0.5" role="group" aria-label="Moteur de recherche">
          {([[undefined, "Google et Bing"], ["gsc", "Google"], ["bing", "Bing"]] as const).map(([k, l]) => (
            <button key={l} type="button" aria-pressed={provider === k} onClick={() => s.set({ moteur: k ?? null })}
              className={cn("rounded-[13px] px-3 py-1.5 text-[13px] font-semibold transition-colors", provider === k ? "bg-ink text-[var(--background)]" : "text-muted hover:text-ink")}>{l}</button>
          ))}
        </div>
        <p className="text-xs text-muted">Les deux ou trois derniers jours sont provisoires chez Google ; Bing publie ses mots-clés par semaine.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Clics", value: short(t.clicks), cur: t.clicks, prev: t.previous_clicks },
          { label: "Impressions", value: short(t.impressions), cur: t.impressions, prev: t.previous_impressions },
          { label: "Taux de clic", value: percent(rate(t.clicks, t.impressions)), cur: rate(t.clicks, t.impressions), prev: rate(t.previous_clicks, t.previous_impressions), suffix: "pt" },
          { label: "Mots-clés suivis", value: num(data.queries.length), cur: 0, prev: 0, plain: true },
        ].map((k) => (
          <div key={k.label} className="trk-card p-4">
            <p className="text-xs font-semibold text-muted">{k.label}</p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <p className="text-[26px] leading-none font-extrabold tracking-tight text-ink">{k.value}</p>
              {!k.plain && <Delta current={k.cur} previous={k.prev} suffix={k.suffix} />}
            </div>
          </div>
        ))}
      </div>

      <Panel title="Clics depuis les moteurs de recherche" hint={data.series.bucket === "week" ? "Par semaine." : "Par jour."}>
        <StackedArea points={points} series={series} bucket={data.series.bucket} label="Clics depuis Google et Bing dans le temps" total="Clics" height="h-56" />
        {series.length > 1 && <div className="mt-3"><Legend items={series} /></div>}
      </Panel>

      {query && (
        <Panel title={`Position de « ${query} »`} hint="Position moyenne dans les résultats : plus la courbe est haute, mieux le mot-clé est classé."
          action={<button type="button" onClick={() => setQuery(null)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-violet-strong hover:bg-violet-soft"><X size={13} aria-hidden /> Fermer</button>}>
          {posSeries.length === 0 ? <p className="py-10 text-center text-sm text-muted">Aucune position mesurée pour ce mot-clé sur la période.</p> : (
            <>
              <Lines points={posPoints} series={posSeries} bucket={data.series.bucket} label={`Courbe de position du mot-clé ${query}`} reversed unit={(v) => `position ${pos(v)}`} height="h-56" />
              {posSeries.length > 1 && <div className="mt-3"><Legend items={posSeries} /></div>}
            </>
          )}
        </Panel>
      )}

      <Panel title="Mots-clés" hint="Clique un mot-clé pour voir sa courbe de position. « RDV de la page » : rendez-vous pris par des visiteurs venus d'un moteur et entrés par la page que ce mot-clé fait ressortir.">
        <DataTable rows={data.queries} columns={cols} rowKey={(r) => `${r.provider}:${r.query}`} limit={60}
          onRow={(r) => setQuery(query === r.query ? null : r.query)} rowTitle={() => "Voir la courbe de position"}
          empty="Aucun mot-clé sur cette période." />
      </Panel>

      <Panel title="Pages, mots-clés et rendez-vous" hint="Pour chaque page : ce que les moteurs en disent (clics, position) et ce que le site mesure (visites de recherche organique entrées par cette page, rendez-vous). Clique une page pour filtrer.">
        <DataTable rows={data.pages} columns={pageCols} rowKey={(r) => `${r.provider}:${r.page}`} limit={40}
          onRow={(r) => s.setFilter("page", s.filters.page === r.page ? null : r.page)} rowTitle={() => "Filtrer sur cette page"}
          empty="Aucune page sur cette période." />
      </Panel>
    </div>
  );
}
