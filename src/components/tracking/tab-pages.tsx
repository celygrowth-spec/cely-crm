"use client";

// Pages : pages d'entrée, pages les plus vues, temps passé, défilement, pages qui convertissent et pages qui
// font fuir. Chaque page est cliquable : elle devient le filtre « Page » de tout le tableau de bord.
import { FileText } from "lucide-react";
import { cn } from "@/components/ui";
import { BarList, DataTable, Empty, ErrorNote, Panel, TabSkeleton, share, type Column } from "./bits";
import { num, percent, seconds, short, useReport, type TrackingState } from "./state";
import type { PagesReport } from "./types";

type Page = PagesReport["pages"][number];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="trk-card min-w-0 p-4">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 font-sans text-2xl leading-none font-extrabold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-1.5 truncate text-xs text-muted" title={sub}>{sub}</p>}
    </div>
  );
}

export function PagesTab({ s }: { s: TrackingState }) {
  const { data, loading, stale, error, refetch } = useReport<PagesReport>("pages", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  const { pages } = data;
  if (!pages.length) {
    return (
      <Empty icon={<FileText size={20} />} title="Aucune page vue sur cette période">
        Les pages apparaissent ici dès qu&apos;un visiteur les ouvre sur le site où le script de mesure est installé.
        Élargis la période ou retire un filtre pour retrouver des données.
      </Empty>
    );
  }
  const active = s.filters.page ?? null;
  const pick = (path: string) => s.setFilter("page", active === path ? null : path);

  // « assez de visites » : au moins 20, ou dans le premier tiers des pages les plus visitées (petits sites, périodes courtes)
  const byVisits = [...pages].sort((a, b) => b.visits - a.visits);
  const floor = Math.min(20, byVisits[Math.max(0, Math.ceil(byVisits.length / 3) - 1)].visits);
  const enough = pages.filter((p) => p.visits >= floor);
  const converting = enough.filter((p) => p.bookings > 0).sort((a, b) => b.rate - a.rate || b.bookings - a.bookings).slice(0, 8);
  const leaking = enough.filter((p) => p.exits > 0).sort((a, b) => b.exit_rate - a.exit_rate || b.exits - a.exits).slice(0, 8);
  const entries = pages.filter((p) => p.entries > 0).sort((a, b) => b.entries - a.entries).slice(0, 8);
  const views = pages.reduce((n, p) => n + p.views, 0);
  const longest = [...enough].sort((a, b) => b.avg_duration - a.avg_duration)[0];
  const tone = (p: Page, color?: string) => (active === p.path ? "var(--ink)" : color);

  const columns: Column<Page>[] = [
    {
      key: "path", label: "Page",
      render: (p) => (
        <span className={cn("inline-block max-w-[16rem] truncate align-middle font-semibold text-ink sm:max-w-sm", active === p.path && "rounded-md bg-violet-soft px-1.5 py-0.5")}
          aria-current={active === p.path ? "true" : undefined}>{p.path}</span>
      ),
    },
    { key: "views", label: "Vues", align: "right", render: (p) => num(p.views) },
    { key: "visits", label: "Visites", align: "right", render: (p) => num(p.visits) },
    { key: "entries", label: "Entrées", align: "right", render: (p) => num(p.entries) },
    { key: "duration", label: "Temps moyen", align: "right", render: (p) => seconds(p.avg_duration) },
    {
      key: "scroll", label: "Défilement", align: "right",
      render: (p) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden h-1.5 w-12 overflow-hidden rounded-full sm:block" style={{ background: "var(--trk-track)" }} aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.min(100, p.avg_scroll ?? 0)}%`, background: "var(--trk-seq-3)" }} />
          </span>
          {percent(p.avg_scroll, 0)}
        </span>
      ),
    },
    { key: "exits", label: "Sorties", align: "right", render: (p) => <>{num(p.exits)}<span className="ml-1.5 text-xs text-muted">{percent(p.exit_rate, 0)}</span></> },
    { key: "bookings", label: "Rendez-vous", align: "right", render: (p) => (p.bookings ? <strong className="font-semibold text-ink">{num(p.bookings)}</strong> : <span className="text-muted">0</span>) },
    { key: "rate", label: "Conversion", align: "right", render: (p) => (p.bookings ? percent(p.rate, 2) : <span className="text-muted">–</span>) },
  ];

  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pages vues" value={short(views)} sub={`${num(pages.length)} pages différentes`} />
        <Stat label="Visites" value={short(data.visits)} sub={data.visits ? `${(views / data.visits).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pages par visite` : undefined} />
        <Stat label="Première page d'entrée" value={entries[0] ? share(entries[0].entries, data.visits) : "–"} sub={entries[0]?.path} />
        <Stat label="Lecture la plus longue" value={longest ? seconds(longest.avg_duration) : "–"} sub={longest?.path} />
      </div>

      <Panel title="Toutes les pages" hint={active ? "Les chiffres portent sur les visites passées par la page filtrée. Clique-la de nouveau pour retirer le filtre." : "Classées par nombre de vues. Clique une page pour filtrer tout le tableau de bord sur elle."}>
        <DataTable rows={pages} columns={columns} rowKey={(p) => p.path} onRow={(p) => pick(p.path)} limit={50}
          rowTitle={(p) => (active === p.path ? "Retirer le filtre sur cette page" : `Filtrer sur ${p.path}`)} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Pages qui convertissent" hint={`Part des visites passées par la page qui mènent à un rendez-vous (pages d'au moins ${num(floor)} visites).`}>
          <div className="-mx-2">
            <BarList onPick={pick} unit={(v) => percent(v, 1)} empty="Aucun rendez-vous pris après une visite sur la période."
              items={converting.map((p) => ({ key: p.path, label: p.path, value: p.rate, sub: `${num(p.bookings)} rdv`, color: tone(p, "var(--trk-up)"), title: `${num(p.bookings)} rendez-vous pour ${num(p.visits)} visites` }))} />
          </div>
        </Panel>
        <Panel title="Pages qui font fuir" hint={`Part des visites qui se terminent sur la page (pages d'au moins ${num(floor)} visites).`}>
          <div className="-mx-2">
            <BarList onPick={pick} unit={(v) => percent(v, 0)} max={100} empty="Aucune sortie mesurée sur la période."
              items={leaking.map((p) => ({ key: p.path, label: p.path, value: p.exit_rate, sub: `${num(p.exits)} sorties`, color: tone(p, "var(--trk-down)"), title: `${num(p.exits)} sorties pour ${num(p.visits)} visites` }))} />
          </div>
        </Panel>
        <Panel title="Pages d'entrée" hint="Première page vue lors d'une visite.">
          <div className="-mx-2">
            <BarList onPick={pick} empty="Aucune entrée mesurée sur la période."
              items={entries.map((p) => ({ key: p.path, label: p.path, value: p.entries, sub: share(p.entries, data.visits), color: tone(p), title: `${num(p.bounces)} visites d'une seule page` }))} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
