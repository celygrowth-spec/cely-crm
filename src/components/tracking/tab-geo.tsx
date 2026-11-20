"use client";

// Géographie : carte des pays (cliquable), classement des pays, répartition par appareil et par navigateur,
// part des visiteurs récurrents.
import { Globe2 } from "lucide-react";
import { cn } from "@/components/ui";
import { BarList, Empty, ErrorNote, Panel, TabSkeleton, share } from "./bits";
import { DEVICE_LABEL, countryName, num, percent, rate, seconds, short, useReport, type TrackingState } from "./state";
import type { GeoReport } from "./types";
import { WorldMap } from "./world-map";

// une teinte par appareil (elle suit l'appareil, pas son rang) et la couleur du texte posé dessus
const DEVICE_TONE: Record<string, { bg: string; fg: string }> = {
  desktop: { bg: "var(--trk-seq-4)", fg: "var(--trk-card)" },
  mobile: { bg: "var(--trk-seq-3)", fg: "var(--ink)" },
  tablet: { bg: "var(--trk-seq-2)", fg: "var(--ink)" },
};
const OTHER_TONE = { bg: "var(--trk-seq-1)", fg: "var(--ink)" };
const deviceLabel = (d: string | null) => (d ? DEVICE_LABEL[d] ?? d : "Inconnu");

function Devices({ devices, active, onPick }: { devices: GeoReport["devices"]; active?: string; onPick: (device: string) => void }) {
  const total = devices.reduce((n, d) => n + d.visits, 0);
  if (!total) return <p className="py-6 text-center text-sm text-muted">Aucune visite sur la période.</p>;
  return (
    <>
      <div className="flex h-7 gap-0.5" role="group" aria-label="Répartition des visites par appareil">
        {devices.filter((d) => d.visits > 0).map((d) => {
          const tone = DEVICE_TONE[d.device] ?? OTHER_TONE;
          const part = rate(d.visits, total);
          return (
            <button key={d.device ?? "?"} type="button" onClick={() => onPick(d.device)} aria-pressed={active === d.device}
              title={`${deviceLabel(d.device)} : ${num(d.visits)} visites (${share(d.visits, total)})`}
              aria-label={`${deviceLabel(d.device)} : ${num(d.visits)} visites, ${share(d.visits, total)}`}
              className={cn("trk-bar flex h-full min-w-1.5 items-center justify-center overflow-hidden rounded-md text-[11px] font-bold tabular-nums hover:opacity-85", active && active !== d.device && "opacity-40")}
              style={{ width: `${part}%`, background: tone.bg, color: tone.fg }}>
              {part >= 14 ? share(d.visits, total) : null}
            </button>
          );
        })}
      </div>
      <ul className="mt-3 grid gap-0.5">
        {devices.map((d) => (
          <li key={d.device ?? "?"}>
            <button type="button" onClick={() => onPick(d.device)} aria-pressed={active === d.device}
              title={active === d.device ? "Retirer ce filtre" : `Filtrer sur ${deviceLabel(d.device)}`}
              className={cn("trk-row flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm", active === d.device && "bg-violet-soft")}>
              <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: (DEVICE_TONE[d.device] ?? OTHER_TONE).bg }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink">{deviceLabel(d.device)}</span>
                <span className="block text-xs text-muted">{seconds(d.avg_duration)} en moyenne · {num(d.bookings)} rendez-vous</span>
              </span>
              <span className="shrink-0 text-right tabular-nums text-ink">{num(d.visits)}<span className="ml-1.5 text-xs text-muted">{share(d.visits, total)}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function GeoTab({ s }: { s: TrackingState }) {
  const { data, loading, stale, error, refetch } = useReport<GeoReport>("geo", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  if (!data.visits) {
    return (
      <Empty icon={<Globe2 size={20} />} title="Aucune visite à situer sur cette période">
        Le pays et l&apos;appareil sont relevés à chaque visite mesurée par le script du site. Élargis la période ou retire un filtre pour retrouver des données.
      </Empty>
    );
  }
  const pickCountry = (code: string) => s.setFilter("country", s.filters.country === code ? null : code);
  const pickDevice = (device: string) => s.setFilter("device", s.filters.device === device ? null : device);
  const known = data.countries.filter((c) => c.country !== "??");
  const located = known.reduce((n, c) => n + c.visits, 0);
  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Visites par pays"
          hint={`${num(known.length)} pays sur la période. Clique un pays pour filtrer tout le tableau de bord.`}>
          <WorldMap countries={known} active={s.filters.country ?? null} onPick={pickCountry} />
        </Panel>
        <Panel title="Classement des pays" hint={located < data.visits ? `${num(data.visits - located)} visites sans pays connu.` : "Part des visites de la période."}>
          <div className="-mx-2 max-h-[26rem] overflow-y-auto pr-1">
            <BarList onPick={pickCountry}
              items={known.map((c) => ({
                key: c.country, label: countryName(c.country), value: c.visits, sub: share(c.visits, data.visits),
                color: s.filters.country === c.country ? "var(--ink)" : undefined,
                title: `${num(c.visitors)} visiteurs · ${num(c.bookings)} rendez-vous`,
              }))} />
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Appareils" hint="Clique un appareil pour filtrer.">
          <Devices devices={data.devices} active={s.filters.device} onPick={pickDevice} />
        </Panel>
        <Panel title="Navigateurs" hint="Visites par navigateur.">
          <div className="-mx-2">
            <BarList items={data.browsers.slice(0, 8).map((b) => ({ key: b.browser, label: b.browser, value: b.visits, sub: share(b.visits, data.visits) }))} />
          </div>
        </Panel>
        <Panel title="Visiteurs récurrents" hint="Visites de personnes déjà venues sur le site.">
          <p className="font-sans text-[28px] leading-none font-extrabold tracking-tight text-ink">{percent(rate(data.returning, data.visits), 0)}</p>
          <p className="mt-1.5 text-sm text-muted">{short(data.returning)} visites sur {short(data.visits)}</p>
          <div className="mt-4 flex h-2 gap-0.5" aria-hidden>
            <span className="trk-bar block h-full rounded-full" style={{ width: `${rate(data.returning, data.visits)}%`, background: "var(--trk-seq-4)" }} />
            <span className="block h-full flex-1 rounded-full" style={{ background: "var(--trk-track)" }} />
          </div>
          <ul className="mt-3 grid gap-1 text-xs text-muted">
            <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "var(--trk-seq-4)" }} aria-hidden /><span className="text-ink">Déjà venus</span> <span className="tabular-nums">{num(data.returning)}</span></li>
            <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "var(--trk-track)" }} aria-hidden /><span className="text-ink">Première visite</span> <span className="tabular-nums">{num(data.visits - data.returning)}</span></li>
          </ul>
          <p className="mt-3 border-t border-line pt-2 text-xs text-muted">Sans consentement aux cookies, un visiteur n&apos;est pas reconnu d&apos;une visite à l&apos;autre : la part réelle est plus élevée.</p>
        </Panel>
      </div>
    </div>
  );
}
