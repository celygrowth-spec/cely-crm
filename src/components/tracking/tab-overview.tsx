"use client";

// Vue d'ensemble : « À faire », chiffres clés (variation et mini-courbe), visites par source dans le temps,
// entonnoir Visite → Clic rendez-vous → Rendez-vous.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Bot, FileWarning, Link2, Plug, Search, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { CHANNEL_ORDER, channelLabel, channelVar, sourceName } from "@/lib/tracking/channels";
import { Delta, Empty, ErrorNote, Legend, Panel, TabSkeleton } from "./bits";
import { Sparkline, StackedArea, type Point } from "./charts-lazy";
import { addDays, num, percent, rate, short, useReport, type TrackingState } from "./state";
import type { Overview, Recommendation } from "./types";

function Kpi({ label, value, current, previous, points, dataKey, color, suffix, hint }: {
  label: string; value: string; current: number; previous: number; points: Point[]; dataKey: string; color?: string; suffix?: string; hint?: string;
}) {
  return (
    <div className="trk-card flex min-w-0 flex-col p-4" title={hint}>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <p className="font-sans text-2xl leading-none font-extrabold tracking-tight whitespace-nowrap text-ink sm:text-[28px]">{value}</p>
        <Delta current={current} previous={previous} suffix={suffix} />
      </div>
      <div className="mt-2"><Sparkline points={points} dataKey={dataKey} color={color} /></div>
    </div>
  );
}

function Action({ icon, children, onClick, href, cta }: { icon: ReactNode; children: ReactNode; onClick?: () => void; href?: string; cta: string }) {
  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-soft text-violet-strong">{icon}</span>
      <span className="min-w-0 flex-1 text-sm text-ink">{children}</span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-violet-strong"><span className="hidden sm:inline">{cta}</span> <ArrowRight size={14} aria-label={cta} /></span>
    </>
  );
  const cls = "trk-row flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left";
  return <li>{href ? <Link href={href} className={cls}>{body}</Link> : <button type="button" onClick={onClick} className={cls}>{body}</button>}</li>;
}

/** Lot 7 : quelques actions concrètes tirées des données, chacune renvoie vers le détail correspondant. */
function Todo({ s }: { s: TrackingState }) {
  const { data } = useReport<Recommendation[]>("recommendations", s);
  if (!data?.length) return null;
  const PROVIDER = { gsc: "Google Search Console", bing: "Bing Webmaster Tools" } as const;
  // quelques actions, pas une liste : les deux connecteurs à brancher tiennent en une ligne, le reste est borné
  const missing = data.filter((r) => r.kind === "connector" && r.data.status === "missing");
  const list = (missing.length === 2 ? data.filter((r) => !missing.includes(r)) : data).slice(0, missing.length === 2 ? 4 : 5);
  return (
    <Panel title="À faire" hint="Tiré des données de la période, pour obtenir plus de prospects." className="mb-4">
      <ul className="grid gap-0.5" data-todo>
        {missing.length === 2 && (
          <Action icon={<Plug size={15} />} href="/parametres/connecteurs" cta="Connecteurs">
            Branche <strong className="font-semibold">Google Search Console</strong> et <strong className="font-semibold">Bing Webmaster Tools</strong> pour voir les mots-clés qui amènent des visites.
          </Action>
        )}
        {list.map((r, i) => {
          const b = (t: ReactNode) => <strong className="font-semibold">{t}</strong>;
          switch (r.kind) {
            case "connector":
              return <Action key={i} icon={<Plug size={15} />} href="/parametres/connecteurs" cta="Connecteurs">
                {r.data.status === "missing" ? <>Branche {b(PROVIDER[r.data.provider])} pour voir les mots-clés qui amènent des visites.</> : <>{b(PROVIDER[r.data.provider])} est à reconnecter : les mots-clés ne sont plus mis à jour.</>}
              </Action>;
            case "keyword":
              return <Action key={i} icon={<Search size={15} />} onClick={() => s.goto("seo", { q: r.data.query })} cta="Voir le mot-clé">
                Pousse {b(`« ${r.data.query} »`)} : position {r.data.position.toLocaleString("fr-FR")} avec {num(r.data.impressions)} impressions, la première page est à portée.
              </Action>;
            case "page":
              return <Action key={i} icon={<FileWarning size={15} />} onClick={() => s.goto("pages", { page: r.data.path })} cta="Voir la page">
                {b(r.data.path)} reçoit {num(r.data.visits)} visites sans aucun rendez-vous : ajoute un appel à l&apos;action plus visible.
              </Action>;
            case "trend": {
              const up = r.data.change > 0;
              const name = r.data.scope === "channel" ? channelLabel(r.data.name) : `la campagne ${r.data.name}`;
              return <Action key={i} icon={up ? <TrendingUp size={15} /> : <TrendingDown size={15} />} cta="Voir le détail"
                onClick={() => (r.data.scope === "channel" ? s.goto("sources", { channel: r.data.name }) : s.goto("campagnes", { campaign: r.data.name }))}>
                {b(name)} {up ? "est en forte hausse" : "est en forte baisse"} : {num(r.data.visits)} visites contre {num(r.data.previous)} ({up ? "+" : ""}{r.data.change} %). {up ? "Renforce ce qui marche." : "Relance-la ou remplace-la."}
              </Action>;
            }
            case "untagged":
              return <Action key={i} icon={<Link2 size={15} />} onClick={() => s.goto("campagnes")} cta="Générateur de liens UTM">
                {num(r.data.visits)} visites venues de {b(sourceName(r.data.source) ?? channelLabel(r.data.channel))} sans lien UTM : marque tes prochains liens pour savoir lesquels fonctionnent.
              </Action>;
            case "ai_unread":
              return <Action key={i} icon={<Bot size={15} />} onClick={() => s.goto("ia", { page: r.data.path })} cta="Voir les robots">
                {b(r.data.path)} n&apos;a été lue par aucun robot d&apos;IA sur la période : vérifie qu&apos;elle est liée depuis le site et présente dans le plan du site.
              </Action>;
          }
        })}
      </ul>
    </Panel>
  );
}

function Funnel({ visits, cta, bookings }: { visits: number; cta: number; bookings: number }) {
  // étapes ordonnées : une seule teinte, du clair au foncé
  const steps = [
    { label: "Visite", value: visits, color: "var(--trk-seq-2)", from: null as number | null },
    { label: "Clic rendez-vous", value: cta, color: "var(--trk-seq-3)", from: visits },
    { label: "Rendez-vous", value: bookings, color: "var(--trk-seq-4)", from: cta },
  ];
  return (
    <ol className="grid gap-3">
      {steps.map((st) => (
        <li key={st.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-ink">{st.label}</span>
            <span className="tabular-nums text-ink">
              <strong>{num(st.value)}</strong>
              {st.from !== null && <span className="ml-2 text-xs text-muted">{percent(rate(st.value, st.from))} de l&apos;étape précédente</span>}
            </span>
          </div>
          <div className="mt-1.5 h-6 overflow-hidden rounded-md" style={{ background: "var(--trk-track)" }}>
            <div className="trk-bar h-full rounded-md" style={{ width: `${Math.max(rate(st.value, visits), st.value > 0 ? 1 : 0)}%`, background: st.color }} />
          </div>
        </li>
      ))}
      <li className="border-t border-line pt-2 text-xs text-muted">
        {bookings > cta
          ? "Certains rendez-vous sont pris sans clic mesuré (page de réservation ouverte directement)."
          : `Sur ${num(visits)} visites, ${percent(rate(bookings, visits), 2)} mènent à un rendez-vous.`}
      </li>
    </ol>
  );
}

export function OverviewTab({ s }: { s: TrackingState }) {
  const { data, loading, stale, error, refetch } = useReport<Overview>("overview", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  if (!data.has_data) {
    return (
      <Empty icon={<Sparkles size={20} />} title="Aucune visite mesurée pour l'instant">
        Ajoute le script de mesure à celygrowth.com (le texte prêt à coller est dans la pull request et dans <code>docs/tracking-site.md</code>).
        Les visites apparaissent ici dès la première page vue.
      </Empty>
    );
  }
  const { kpis: k, previous: p, series } = data;
  const points: Point[] = series.points.map((pt) => ({
    d: pt.d, visits: pt.visits ?? 0, visitors: pt.visitors ?? 0, bookings: pt.bookings ?? 0, ai: pt.by.ai ?? 0,
    rate: pt.visits ? Number((((pt.bookings ?? 0) / pt.visits) * 100).toFixed(2)) : 0,
    ...Object.fromEntries(CHANNEL_ORDER.map((c) => [c, pt.by[c] ?? 0])),
  }));
  const totals = Object.fromEntries(CHANNEL_ORDER.map((c) => [c, points.reduce((n, pt) => n + Number(pt[c] ?? 0), 0)]));
  const present = CHANNEL_ORDER.filter((c) => totals[c] > 0);
  const chartSeries = present.map((c) => ({ key: c, label: channelLabel(c), color: channelVar(c) }));
  const pick = (d: string) => s.set({ du: d, au: series.bucket === "week" ? (addDays(d, 6) > s.to ? s.to : addDays(d, 6)) : d, periode: null });
  return (
    <div className={stale ? "trk-stale" : "trk-fresh"}>
      <Todo s={s} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-kpis>
        <Kpi label="Visiteurs" value={short(k.visitors)} current={k.visitors} previous={p.visitors} points={points} dataKey="visitors" hint="Personnes distinctes ; sans consentement, chaque visite compte pour un visiteur." />
        <Kpi label="Visites" value={short(k.visits)} current={k.visits} previous={p.visits} points={points} dataKey="visits" />
        <Kpi label="Rendez-vous" value={num(k.bookings)} current={k.bookings} previous={p.bookings} points={points} dataKey="bookings" hint="Rendez-vous pris depuis le site, hors annulations." />
        <Kpi label="Taux de conversion" value={percent(k.rate, 2)} current={k.rate} previous={p.rate} suffix="pt" points={points} dataKey="rate" hint="Rendez-vous rapportés aux visites." />
        <div className="col-span-2 lg:col-span-1">
          <Kpi label="Visites venues des IA" value={short(k.ai_visits)} current={k.ai_visits} previous={p.ai_visits} points={points} dataKey="ai" color={channelVar("ai")} hint="ChatGPT, Perplexity, Claude, Gemini, Copilot…" />
        </div>
      </div>

      <Panel className="mt-4" title="Visites par source" hint={series.bucket === "week" ? "Par semaine. Clique une source pour filtrer, un point pour voir cette semaine." : "Par jour. Clique une source pour filtrer, un point pour voir ce jour."}>
        {k.visits === 0 ? (
          <p className="py-16 text-center text-sm text-muted">Aucune visite sur cette période avec ces filtres.</p>
        ) : (
          <>
            <StackedArea points={points} series={chartSeries} bucket={series.bucket} label="Visites dans le temps, empilées par source" onPickPoint={pick} total="Visites" />
            <div className="mt-3">
              <Legend items={present.map((c) => ({ key: c, label: channelLabel(c), color: channelVar(c), value: totals[c] }))}
                active={s.filters.channel ?? null} onPick={(c) => s.setFilter("channel", s.filters.channel === c ? null : c)} />
            </div>
          </>
        )}
      </Panel>

      <Panel className="mt-4" title="Entonnoir" hint="De la visite au rendez-vous, sur la période.">
        <Funnel visits={k.visits} cta={k.cta_visits} bookings={k.bookings} />
      </Panel>
    </div>
  );
}
