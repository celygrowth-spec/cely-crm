"use client";

// Prospects : visiteurs identifiés et convertis, avec leur première et leur dernière source, la source déclarée,
// leurs visites et leur rendez-vous. Une ligne rattachée à une fiche ouvre cette fiche.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, UserRoundSearch } from "lucide-react";
import { cn } from "@/components/ui";
import { sourceName } from "@/lib/tracking/channels";
import { ChannelChip, Empty, ErrorNote, Panel, TabSkeleton } from "./bits";
import { num, percent, rate, useReport, type TrackingState } from "./state";
import type { ProspectsReport, Touch } from "./types";

type Prospect = ProspectsReport["prospects"][number];

const dDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const dShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const dTime = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso: string | null) => (iso ? dDay.format(new Date(iso)) : "–");

/** Détail d'une source : « Google », « linkedin / lancement »… */
const detail = (t: Touch) => (t.channel === "campaign" ? [t.source, t.campaign].filter(Boolean).join(" / ") : sourceName(t.source)) || null;
const sameTouch = (a: Touch, b: Touch) => a.channel === b.channel && (a.source ?? "") === (b.source ?? "") && (a.campaign ?? "") === (b.campaign ?? "");

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="trk-card min-w-0 p-4">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 font-sans text-2xl leading-none font-extrabold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function Booking({ p }: { p: Prospect }) {
  if (!p.booked) return <span className="block whitespace-nowrap text-muted">Formulaire<span className="block text-xs">sans rendez-vous</span></span>;
  // date du rendez-vous quand elle est connue, sinon date de la prise de rendez-vous
  const when = p.booking_starts_at ? dTime.format(new Date(p.booking_starts_at)) : `Pris le ${day(p.converted_at)}`;
  const cancelled = p.booking_status === "cancelled";
  const status = cancelled ? "Annulé" : p.booking_status === "confirmed" ? "Confirmé" : p.booking_status === "pending" ? "En attente" : p.booking_status ? "Non abouti" : null;
  const taken = p.booking_starts_at && p.converted_at ? `pris le ${dShort.format(new Date(p.converted_at))}` : null;
  const sub = [status, taken, !status && !p.counted ? "Non compté" : null].filter(Boolean).join(" · ");
  return (
    <span className="block">
      <span className={cn("block whitespace-nowrap", cancelled ? "text-muted line-through" : "text-ink")}>{when}</span>
      {sub && <span className="block text-xs whitespace-nowrap text-muted">{sub}</span>}
    </span>
  );
}

const HEAD = ["Fiche", "Première source", "Dernière source", "Source déclarée", "Visites", "Rendez-vous", ""];

export function ProspectsTab({ s }: { s: TrackingState }) {
  const router = useRouter();
  // la liste s'ouvre sur les plus récents ; la suite s'affiche à la demande
  const [shown, setShown] = useState(40);
  const { data, loading, stale, error, refetch } = useReport<ProspectsReport>("prospects", s);
  if (error) return <ErrorNote message={error} retry={refetch} />;
  if (loading || !data) return <TabSkeleton />;
  const rows = data.prospects;
  if (!rows.length) {
    return (
      <Empty icon={<UserRoundSearch size={20} />} title="Aucun prospect sur cette période">
        Un prospect apparaît ici dès qu&apos;un visiteur prend rendez-vous ou envoie un formulaire sur le site : on voit alors
        d&apos;où il est venu la première fois et ce qui l&apos;a décidé. Élargis la période ou retire un filtre pour en retrouver.
      </Empty>
    );
  }
  const counted = rows.filter((p) => p.counted).length;
  const booked = rows.filter((p) => p.booked).length;
  const measured = rows.filter((p) => p.first.channel && p.last.channel);
  const changed = measured.filter((p) => !sameTouch(p.first, p.last)).length;
  const toLink = rows.filter((p) => !p.company_id).length;
  const channel = s.filters.channel;
  const chip = (t: Touch) => (
    <span className="inline-flex max-w-[11.5rem]" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <ChannelChip channel={t.channel} detail={detail(t)} onClick={t.channel ? () => s.setFilter("channel", channel === t.channel ? null : t.channel) : undefined} />
    </span>
  );
  const cell = "py-2.5 align-middle px-1.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5";

  return (
    <div className={cn("grid gap-4", stale ? "trk-stale" : "trk-fresh")}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Prospects" value={num(rows.length)} sub={rows.length - booked > 0 ? `dont ${num(rows.length - booked)} par formulaire, sans rendez-vous` : "Tous ont pris rendez-vous"} />
        <Stat label="Rendez-vous comptés" value={num(counted)} sub={booked - counted > 0 ? `${num(booked - counted)} non comptés (annulés ou non aboutis)` : "Hors annulations"} />
        <Stat label="Source différente entre la première et la dernière visite" value={percent(rate(changed, measured.length), 0)}
          sub={measured.length ? `${num(changed)} prospects sur ${num(measured.length)} dont le parcours est mesuré` : "Aucun parcours mesuré"} />
      </div>

      <Panel title="Visiteurs identifiés et convertis"
        hint={`Du plus récent au plus ancien. Clique une ligne pour ouvrir la fiche, une source pour filtrer.${toLink ? ` ${num(toLink)} à rattacher à une fiche.` : ""}`}>
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          {/* Tableau propre à cet onglet : seules les lignes rattachées à une fiche sont cliquables. */}
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {HEAD.map((h, i) => (
                  <th key={i} scope="col" aria-label={h ? undefined : "Ouvrir la fiche"} className={cn("py-2 font-label text-[11px] font-bold tracking-wide whitespace-nowrap text-muted uppercase px-1.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5", h === "Visites" && "text-right")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((p) => {
                const open = p.company_id ? () => router.push(`/fiches/${p.company_id}`) : undefined;
                return (
                  <tr key={p.key} tabIndex={open ? 0 : undefined} onClick={open}
                    title={open ? `Ouvrir la fiche ${p.company_name ?? ""}`.trim() : "Le rendez-vous existe mais n'est pas encore rattaché à une fiche."}
                    onKeyDown={open ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } : undefined}
                    className={cn("border-b border-line/60 last:border-0", open && "trk-row cursor-pointer")}>
                    <td className={cell}>
                      {p.company_id ? (
                        <>
                          <span className="block max-w-[12rem] truncate font-semibold text-ink">{p.company_name ?? p.person_name ?? "Fiche sans nom"}</span>
                          {p.company_name && p.person_name && <span className="block max-w-[12rem] truncate text-xs text-muted">{p.person_name}</span>}
                        </>
                      ) : (
                        <span className="text-muted">Fiche à rattacher</span>
                      )}
                    </td>
                    <td className={cell}>{chip(p.first)}</td>
                    <td className={cell}>{chip(p.last)}</td>
                    <td className={cell}>{p.declared_source ? <span className="block max-w-[12rem] truncate text-ink" title={p.declared_source}>{p.declared_source}</span> : <span className="text-muted">–</span>}</td>
                    <td className={cn(cell, "text-right whitespace-nowrap text-ink")}>
                      <span className="block tabular-nums">{num(p.visits)}</span>
                      {p.last_visit_at && <span className="block text-xs text-muted">dernière le {dShort.format(new Date(p.last_visit_at))}</span>}
                    </td>
                    <td className={cell}><Booking p={p} /></td>
                    <td className="py-2.5 pr-4 align-middle text-muted sm:pr-5">{open && <ChevronRight size={15} aria-hidden />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > shown && (
          <div className="pt-3 text-center">
            <button type="button" onClick={() => setShown(shown + 60)} className="h-9 rounded-[10px] border border-line px-4 text-[13px] font-semibold text-ink hover:border-violet">
              Afficher la suite ({num(rows.length - shown)} autres)
            </button>
          </div>
        )}
        {rows.length >= 300 && <p className="pt-2 text-xs text-muted">Seuls les 300 prospects les plus récents sont affichés : affine la période ou les filtres.</p>}
      </Panel>
    </div>
  );
}
