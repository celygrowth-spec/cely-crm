"use client";

// IA : d'un côté les visites humaines venues des assistants (ChatGPT, Perplexity, Claude…), de l'autre les
// robots d'IA qui lisent le site (quelles pages, à quelle fréquence, origine vérifiée ou non).
import { useState, type ReactNode } from "react";
import { Bot, ShieldAlert, ShieldCheck, ShieldQuestion, Sparkles } from "lucide-react";
import { cn } from "@/components/ui";
import { sourceName } from "@/lib/tracking/channels";
import { BarList, DataTable, Empty, ErrorNote, Legend, Panel, TabSkeleton, share, type Column } from "./bits";
import { Lines, StackedArea, type Point } from "./charts-lazy";
import { dayShort, daysBetween, num, percent, rate, seconds, short, useReport, type TrackingState } from "./state";
import type { AiReport } from "./types";

type Engine = AiReport["engines"][number];
type Robot = AiReport["bots"][number];

// Un moteur d'IA n'est pas une source : il a sa propre couleur, fixe, qui suit le moteur et jamais son rang.
const ENGINES = ["chatgpt", "perplexity", "claude", "gemini", "copilot", "mistral"] as const;
const ENGINE_COLOR: Record<string, string> = {
  chatgpt: "var(--trk-c-organic)", perplexity: "var(--trk-c-direct)", claude: "var(--trk-c-campaign)",
  gemini: "var(--trk-c-social)", copilot: "var(--trk-c-email)", mistral: "var(--trk-c-referral)",
};
const OTHERS = "autres";
const OTHERS_COLOR = "var(--trk-c-paid)";
const engineColor = (e: string) => ENGINE_COLOR[e] ?? OTHERS_COLOR;
const engineName = (e: string) => (e === "autre" ? "Autre assistant" : sourceName(e) ?? e);

const KIND_LABEL: Record<Robot["kind"], string> = { ai: "IA", search: "Recherche", other: "Autre" };
const KIND_SERIES = [
  { key: "ai", label: "Robots d'IA", color: "var(--trk-c-ai)" },
  { key: "search", label: "Moteurs de recherche", color: "var(--trk-c-organic)" },
  { key: "other", label: "Autres", color: "var(--trk-c-direct)" },
];

const dWhen = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="trk-card min-w-0 p-4">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 font-sans text-2xl leading-none font-extrabold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function SectionTitle({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <header className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-soft text-violet-strong" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        <p className="text-sm text-muted">{children}</p>
      </div>
    </header>
  );
}

/** Origine d'un robot : son éditeur publie (ou non) les adresses depuis lesquelles il passe. */
function Origin({ r }: { r: Robot }) {
  const tone = "inline-flex items-center gap-1.5 whitespace-nowrap";
  if (r.unverified) {
    return (
      <span className={cn(tone, "text-ink")} title="Passages faits sous le nom de ce robot depuis une adresse que son éditeur ne liste pas : probablement un imposteur. Ils ne sont pas comptés dans les pages lues.">
        <ShieldAlert size={14} className="text-warning" aria-hidden /> {num(r.unverified)} {r.unverified > 1 ? "passages non vérifiés" : "passage non vérifié"}
      </span>
    );
  }
  if (r.verified) {
    return <span className={cn(tone, "text-ink")} title="Le robot passe depuis les adresses publiées par son éditeur."><ShieldCheck size={14} className="text-success" aria-hidden /> Vérifiée</span>;
  }
  return <span className={cn(tone, "text-muted")} title="L'éditeur de ce robot ne publie pas la liste de ses adresses : l'origine ne peut pas être contrôlée."><ShieldQuestion size={14} aria-hidden /> Non vérifiable</span>;
}

function Engines({ s, data }: { s: TrackingState; data: AiReport }) {
  const { engines, series } = data;
  const visits = engines.reduce((n, e) => n + e.visits, 0);
  const bookings = engines.reduce((n, e) => n + e.bookings, 0);
  const first = engines.reduce((n, e) => n + e.bookings_first, 0);
  const active = s.filters.channel === "ai" ? s.filters.source ?? null : null;
  const pick = (engine: string) => s.set(active === engine ? { source: null } : { channel: "ai", source: engine });

  // courbes : les six moteurs connus (dans leur ordre fixe), tout le reste regroupé dans « Autres »
  const known = ENGINES.filter((e) => engines.some((x) => x.source === e && x.visits > 0));
  const hasOthers = engines.some((x) => !(ENGINES as readonly string[]).includes(x.source) && x.visits > 0);
  const chartSeries = [
    ...known.map((e) => ({ key: e as string, label: engineName(e), color: engineColor(e) })),
    ...(hasOthers ? [{ key: OTHERS, label: "Autres", color: OTHERS_COLOR }] : []),
  ];
  const points: Point[] = series.points.map((pt) => {
    const row: Point = { d: pt.d };
    for (const e of known) row[e] = pt.by[e] ?? 0;
    if (hasOthers) row[OTHERS] = Object.entries(pt.by).reduce((n, [k, v]) => ((ENGINES as readonly string[]).includes(k) ? n : n + v), 0);
    return row;
  });
  const totalOf = (key: string) => points.reduce((n, pt) => n + Number(pt[key] ?? 0), 0);

  const columns: Column<Engine>[] = [
    {
      key: "engine", label: "Assistant",
      render: (e) => (
        <span className={cn("inline-flex items-center gap-2 font-semibold text-ink", active === e.source && "rounded-md bg-violet-soft px-1.5 py-0.5")} aria-current={active === e.source ? "true" : undefined}>
          <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: engineColor(e.source) }} aria-hidden />{engineName(e.source)}
        </span>
      ),
    },
    { key: "visits", label: "Visites", align: "right", render: (e) => <>{num(e.visits)}<span className="ml-1.5 text-xs text-muted">{share(e.visits, visits)}</span></> },
    { key: "visitors", label: "Visiteurs", align: "right", render: (e) => num(e.visitors) },
    { key: "pages", label: "Pages / visite", align: "right", render: (e) => Number(e.avg_pages ?? 0).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) },
    { key: "duration", label: "Temps moyen", align: "right", render: (e) => seconds(e.avg_duration) },
    { key: "last", label: "Rdv · dernière source", align: "right", render: (e) => (e.bookings ? <strong className="font-semibold">{num(e.bookings)}</strong> : <span className="text-muted">0</span>) },
    { key: "first", label: "Rdv · première source", align: "right", render: (e) => (e.bookings_first ? num(e.bookings_first) : <span className="text-muted">0</span>) },
    { key: "rate", label: "Conversion", align: "right", render: (e) => (e.bookings ? percent(rate(e.bookings, e.visits), 2) : <span className="text-muted">–</span>) },
  ];

  return (
    <section className="grid gap-4" aria-label="Visites venues des IA">
      <SectionTitle icon={<Sparkles size={17} />} title="Visites venues des IA">
        Des personnes arrivées sur le site depuis une réponse de ChatGPT, Perplexity, Claude, Gemini, Copilot ou d&apos;un autre assistant.
      </SectionTitle>
      {visits === 0 ? (
        <Panel>
          <p className="py-10 text-center text-sm text-muted">
            Aucune visite venue d&apos;un assistant d&apos;IA sur cette période avec ces filtres. Elles apparaissent dès qu&apos;un visiteur clique un lien du site cité dans une réponse.
          </p>
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Visites" value={short(visits)} sub={`${num(engines.length)} ${engines.length > 1 ? "assistants différents" : "assistant"}`} />
            <Stat label="Rendez-vous" value={num(bookings)} sub={`L'IA en dernière source · ${num(first)} en première source`} />
            <Stat label="Taux de conversion" value={percent(rate(bookings, visits), 2)} sub="Rendez-vous rapportés aux visites venues des IA" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel className="lg:col-span-2" title="Visites par assistant" hint={`${series.bucket === "week" ? "Par semaine" : "Par jour"}. Clique un assistant pour filtrer tout le tableau de bord.`}>
              <Lines points={points} series={chartSeries} bucket={series.bucket} label="Visites venues des IA dans le temps, une courbe par assistant" />
              <div className="mt-3">
                <Legend items={chartSeries.map((c) => ({ ...c, value: totalOf(c.key) }))} active={active}
                  onPick={(k) => { if (k !== OTHERS) pick(k); }} />
              </div>
            </Panel>
            <Panel title="Pages d'arrivée depuis les IA" hint="Première page vue. Clique pour filtrer sur la page.">
              <div className="-mx-2">
                <BarList onPick={(path) => s.setFilter("page", s.filters.page === path ? null : path)}
                  items={data.landing.slice(0, 8).map((l) => ({ key: l.path, label: l.path, value: l.visits, sub: share(l.visits, visits), color: s.filters.page === l.path ? "var(--ink)" : "var(--trk-c-ai)" }))} />
              </div>
            </Panel>
          </div>
          <Panel title="Détail par assistant" hint="Rendez-vous attribués à la dernière source avant la prise de rendez-vous, et à la toute première visite.">
            <DataTable rows={engines} columns={columns} rowKey={(e) => e.source} onRow={(e) => pick(e.source)}
              rowTitle={(e) => (active === e.source ? "Retirer ce filtre" : `Filtrer sur ${engineName(e.source)}`)} />
          </Panel>
        </>
      )}
    </section>
  );
}

function Robots({ s, data }: { s: TrackingState; data: AiReport }) {
  const [picked, setPicked] = useState<string | null>(null);
  const { bots } = data;
  const title = (
    <SectionTitle icon={<Bot size={17} />} title="Robots d'IA">
      Les programmes qui lisent le site pour alimenter les assistants et les moteurs : quelles pages, et à quelle fréquence.
    </SectionTitle>
  );
  if (!data.has_bots) {
    return (
      <section className="grid gap-4" aria-label="Robots d'IA">
        {title}
        <Empty icon={<Bot size={20} />} title="Aucun passage de robot signalé">
          Un robot n&apos;exécute pas le script de mesure : ses passages sont signalés par le serveur du site.
          Ajoute le signalement des robots au site : voir <code>docs/tracking-site.md</code>. Les passages apparaissent ici dès le premier robot reçu.
        </Empty>
      </section>
    );
  }
  if (!bots.length) {
    return (
      <section className="grid gap-4" aria-label="Robots d'IA">
        {title}
        <Panel><p className="py-10 text-center text-sm text-muted">Aucun robot n&apos;est passé sur cette période{s.filters.page ? " sur la page filtrée" : ""}. Élargis la période pour retrouver leurs passages.</p></Panel>
      </section>
    );
  }
  // robot affiché : celui choisi, sinon le robot d'IA le plus actif
  const current = bots.find((b) => b.bot === picked) ?? bots.find((b) => b.kind === "ai") ?? bots[0];
  const span = daysBetween(s.from, s.to) + 1;
  const frequency = (r: Robot) => (r.days >= span ? "Tous les jours" : `${num(r.days)} ${r.days > 1 ? "jours" : "jour"} sur ${num(span)}`);
  const aiHits = bots.filter((b) => b.kind === "ai").reduce((n, b) => n + b.hits, 0);
  const pages = data.bot_pages.filter((p) => p.bot === current.bot).slice(0, 12);
  const points: Point[] = data.bot_series.points.map((pt) => ({ d: pt.d, ai: pt.by.ai ?? 0, search: pt.by.search ?? 0, other: pt.by.other ?? 0 }));
  const kinds = KIND_SERIES.filter((k) => points.some((pt) => Number(pt[k.key]) > 0));
  const hasPoints = kinds.length > 0;

  const columns: Column<Robot>[] = [
    {
      key: "bot", label: "Robot",
      render: (r) => (
        <span className={cn("inline-flex items-center gap-2 font-semibold text-ink", current.bot === r.bot && "rounded-md bg-violet-soft px-1.5 py-0.5")} aria-current={current.bot === r.bot ? "true" : undefined}>
          <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: KIND_SERIES.find((k) => k.key === r.kind)?.color }} aria-hidden />{r.bot}
        </span>
      ),
    },
    { key: "kind", label: "Type", render: (r) => <span className="text-muted">{KIND_LABEL[r.kind] ?? "Autre"}</span> },
    { key: "hits", label: "Passages", align: "right", render: (r) => num(r.hits) },
    { key: "days", label: "Fréquence", render: (r) => <span className="whitespace-nowrap">{frequency(r)}</span> },
    { key: "pages", label: "Pages lues", align: "right", render: (r) => num(r.pages) },
    { key: "last", label: "Dernière visite", render: (r) => <span className="whitespace-nowrap">{dWhen.format(new Date(r.last_at))}</span> },
    { key: "origin", label: "Origine", render: (r) => <Origin r={r} /> },
  ];

  return (
    <section className="grid gap-4" aria-label="Robots d'IA">
      {title}
      <Panel title="Robots passés sur le site"
        hint={`${num(aiHits)} passages de robots d'IA sur la période. Clique un robot pour voir les pages qu'il lit. « Non vérifié » : un passage sous un nom connu depuis une adresse que l'éditeur ne liste pas, probablement un imposteur.`}>
        <DataTable rows={bots} columns={columns} rowKey={(r) => `${r.bot}-${r.kind}`} onRow={(r) => setPicked(r.bot)} rowTitle={(r) => `Voir les pages lues par ${r.bot}`} limit={25} />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Pages lues par ${current.bot}`} hint="Passages sur la période, et nombre de jours où la page a été lue.">
          <div className="-mx-2">
            <BarList onPick={(path) => s.setFilter("page", s.filters.page === path ? null : path)} empty="Aucun passage vérifié de ce robot sur la période."
              items={pages.map((p) => ({ key: p.path, label: p.path, value: p.hits, sub: `${num(p.days)} j`, color: s.filters.page === p.path ? "var(--ink)" : KIND_SERIES.find((k) => k.key === current.kind)?.color, title: `Dernier passage : ${dayShort(p.last_at.slice(0, 10))}` }))} />
          </div>
        </Panel>
        <Panel title="Pages jamais lues par un robot d'IA" hint="Pages vues par des visiteurs sur la période, qu'aucun robot d'IA n'a lues.">
          {data.unread.length ? (
            <div className="-mx-2">
              <BarList onPick={(path) => s.goto("pages", { page: path })} unit={(v) => `${num(v)} vues`}
                items={data.unread.slice(0, 10).map((u) => ({ key: u.path, label: u.path, value: u.views, color: "var(--trk-seq-2)", title: "Voir cette page dans l'onglet Pages" }))} />
            </div>
          ) : (
            <p className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted">
              <ShieldCheck size={22} className="text-success" aria-hidden />
              <span><strong className="font-semibold text-ink">Tout est lu.</strong> Chaque page visitée sur la période a été lue par au moins un robot d&apos;IA.</span>
            </p>
          )}
        </Panel>
      </div>
      <Panel title="Passages des robots dans le temps" hint={`${data.bot_series.bucket === "week" ? "Par semaine" : "Par jour"}, par type de robot. Les passages non vérifiés sont exclus.`}>
        {hasPoints ? (
          <>
            <StackedArea points={points} series={kinds} bucket={data.bot_series.bucket} height="h-64" label="Passages des robots dans le temps, empilés par type" total="Passages" />
            <div className="mt-3"><Legend items={kinds.map((k) => ({ ...k, value: points.reduce((n, pt) => n + Number(pt[k.key]), 0) }))} /></div>
          </>
        ) : <p className="py-16 text-center text-sm text-muted">Aucun passage vérifié sur cette période.</p>}
      </Panel>
    </section>
  );
}

export function AiTab({ s }: { s: TrackingState }) {
  const { data, loading, stale, error, refetch } = useReport<AiReport>("ai", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  return (
    <div className={cn("grid gap-8", stale ? "trk-stale" : "trk-fresh")}>
      <Engines s={s} data={data} />
      <Robots s={s} data={data} />
    </div>
  );
}
