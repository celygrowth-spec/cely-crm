"use client";

// Campagnes : performances de chaque campagne et de chaque lien UTM, courbes par campagne, Générateur de liens UTM
// et liste des liens créés. Toute visite arrivée par un lien UTM est comptée ici, qu'elle mène ou non à un rendez-vous.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Megaphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteUtmLinkAction } from "@/app/tracking-actions";
import { cn } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import { CHANNEL_ORDER, channelVar } from "@/lib/tracking/channels";
import { DataTable, Empty, ErrorNote, Legend, Panel, TabSkeleton, type Column } from "./bits";
import { Lines, type Point } from "./charts-lazy";
import { addDays, dayShort, num, percent, rate, seconds, useReport, type TrackingState } from "./state";
import type { CampaignsReport, Options } from "./types";
import { UtmBuilder } from "./utm-builder";

type Campaign = CampaignsReport["campaigns"][number];
type LinkRow = CampaignsReport["links"][number];
// une courbe par campagne (six au plus) : couleurs fixes par rang d'apparition dans la période, dans l'ordre validé
const LINE_COLORS = CHANNEL_ORDER.map((c) => channelVar(c));

export function CampaignsTab({ s }: { s: TrackingState }) {
  const qc = useQueryClient();
  const { data, loading, stale, error, refetch } = useReport<CampaignsReport>("campaigns", s);
  const options = useQuery({ queryKey: ["tracking", "options"], queryFn: () => apiGet<Options>("/api/tracking/options"), staleTime: 5 * 60_000 });
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;

  const toggle = (c: string) => s.setFilter("campaign", s.filters.campaign === c ? null : c);
  const series = data.top.map((c, i) => ({ key: c, label: c, color: LINE_COLORS[i % LINE_COLORS.length] }));
  const points: Point[] = data.series.points.map((p) => ({ d: p.d, ...Object.fromEntries(data.top.map((c) => [c, p.by[c] ?? 0])) }));
  const pick = (d: string) => s.set({ du: d, au: data.series.bucket === "week" ? (addDays(d, 6) > s.to ? s.to : addDays(d, 6)) : d, periode: null });
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success("Lien copié."); } catch { toast.error("Copie impossible : sélectionne le lien à la main."); }
  };
  const remove = async (l: LinkRow) => {
    if (!window.confirm(`Supprimer le lien « ${l.name} » ? Les visites déjà mesurées restent comptées dans la campagne.`)) return;
    const r = await deleteUtmLinkAction(l.id);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Lien supprimé.");
    await qc.invalidateQueries({ queryKey: ["tracking"] });
  };

  const cols: Column<Campaign>[] = [
    { key: "c", label: "Campagne", render: (r) => (
      <span className={cn("font-semibold", s.filters.campaign === r.campaign && "text-violet-strong")}>
        {r.campaign}
        <span className="ml-2 font-normal text-muted">{[...(r.sources ?? []), ...(r.mediums ?? [])].filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</span>
      </span>) },
    { key: "v", label: "Visites", align: "right", render: (r) => num(r.visits) },
    { key: "u", label: "Visiteurs", align: "right", render: (r) => num(r.visitors) },
    { key: "p", label: "Pages consultées", align: "right", render: (r) => num(r.pageviews) },
    { key: "d", label: "Durée moyenne", align: "right", render: (r) => seconds(r.avg_duration) },
    { key: "b", label: "Rendez-vous", align: "right", render: (r) => <span title={`${num(r.bookings_first)} en première source`}>{num(r.bookings)}</span> },
    { key: "t", label: "Taux de conversion", align: "right", render: (r) => percent(rate(r.bookings, r.visits), 2) },
  ];
  const linkCols: Column<LinkRow>[] = [
    { key: "n", label: "Lien", className: "max-w-[22rem]", render: (r) => (
      <div className="min-w-0">
        <p className="truncate font-semibold text-ink">{r.name}</p>
        <p className="truncate text-xs text-muted" title={r.url}>{r.path} · {r.utm_source} / {r.utm_medium} / {r.utm_campaign}{r.utm_content ? ` / ${r.utm_content}` : ""}</p>
      </div>) },
    { key: "c", label: "Créé le", render: (r) => <span className="whitespace-nowrap text-muted">{dayShort(r.created_at.slice(0, 10))}</span> },
    { key: "v", label: "Visites", align: "right", render: (r) => num(r.visits) },
    { key: "u", label: "Visiteurs", align: "right", render: (r) => num(r.visitors) },
    { key: "p", label: "Pages", align: "right", render: (r) => num(r.pageviews) },
    { key: "b", label: "Rendez-vous", align: "right", render: (r) => num(r.bookings) },
    { key: "t", label: "Taux", align: "right", render: (r) => percent(rate(r.bookings, r.visits), 2) },
    { key: "a", label: "", align: "right", render: (r) => (
      <span className="inline-flex gap-1">
        <button type="button" onClick={(e) => { e.stopPropagation(); void copy(r.url); }} className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Copier le lien ${r.name}`} title="Copier le lien"><Copy size={14} /></button>
        <button type="button" onClick={(e) => { e.stopPropagation(); void remove(r); }} className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-danger" aria-label={`Supprimer le lien ${r.name}`} title="Supprimer"><Trash2 size={14} /></button>
      </span>) },
  ];

  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      <Panel title="Générateur de liens UTM" hint="Choisis une page, une source, un support et une campagne : le lien est prêt à coller dans un post, un mail ou une signature.">
        <UtmBuilder pages={options.data?.pages ?? ["/"]} campaigns={options.data?.campaigns ?? []} />
      </Panel>

      {data.campaigns.length === 0 ? (
        <Empty icon={<Megaphone size={20} />} title="Aucune visite de campagne sur cette période">
          Crée un lien avec le générateur ci-dessus et partage-le : chaque visite arrivée par ce lien sera comptée dans sa campagne.
          Les liens des mails envoyés depuis Mail et des campagnes de prospection sont marqués automatiquement.
        </Empty>
      ) : (
        <>
          <Panel title="Courbes par campagne" hint={`Les ${series.length > 1 ? `${series.length} campagnes les plus actives` : "campagnes actives"} de la période, par ${data.series.bucket === "week" ? "semaine" : "jour"}.`}>
            <Lines points={points} series={series} bucket={data.series.bucket} label="Visites de chaque campagne dans le temps" onPickPoint={pick} />
            <div className="mt-3"><Legend items={series} active={s.filters.campaign ?? null} onPick={toggle} /></div>
          </Panel>
          <Panel title="Performances par campagne" hint="Clique une campagne pour filtrer tout l'espace. Le rendez-vous est attribué à la campagne de la visite pendant laquelle il a été pris.">
            <DataTable rows={data.campaigns} columns={cols} rowKey={(r) => r.campaign} onRow={(r) => toggle(r.campaign)} rowTitle={(r) => `Filtrer sur ${r.campaign}`} limit={40} />
          </Panel>
        </>
      )}

      <Panel title="Liens créés" hint="Chaque lien du générateur, avec ses résultats sur la période.">
        <DataTable rows={data.links} columns={linkCols} rowKey={(r) => r.id} onRow={(r) => toggle(r.utm_campaign)} rowTitle={(r) => `Filtrer sur la campagne ${r.utm_campaign}`}
          empty="Aucun lien enregistré pour l'instant : le premier lien copié depuis le générateur apparaîtra ici." />
      </Panel>
    </div>
  );
}
