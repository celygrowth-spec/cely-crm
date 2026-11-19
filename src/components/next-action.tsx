"use client";

// La prochaine action principale d'un client, affichée partout où elle a du sens : fiche, carte du Pipeline,
// appel, rendez-vous. Une seule lecture partagée (cache) pour tous les boutons d'un écran.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import { actionHref, nextAction, type JourneyRow, type NextAction } from "@/lib/journey/rules";
import { cn } from "./ui";

export const JOURNEY_KEY = ["journey"];

export function useJourneyRow(companyId: string | null | undefined): JourneyRow | null {
  const { data } = useQuery({ queryKey: JOURNEY_KEY, queryFn: ({ signal }) => apiGet<JourneyRow[]>("/api/parcours", signal), staleTime: 30_000 });
  return (companyId ? data?.find((r) => r.company_id === companyId) : null) ?? null;
}

export function useNextAction(companyId: string | null | undefined): NextAction | null {
  const row = useJourneyRow(companyId);
  return row ? nextAction(row) : null;
}

const STYLE = {
  primary: "inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-xs font-semibold text-white hover:bg-violet-strong",
  quiet: "inline-flex items-center gap-1 text-xs font-semibold text-violet-strong hover:underline",
};

/**
 * Bouton de la prochaine action. `onAct` : sur la fiche elle-même, l'action change d'onglet au lieu de naviguer.
 * Rien ne s'affiche si la fiche n'est pas dans le parcours.
 */
export function NextActionButton({ companyId, variant = "quiet", onAct, className }: { companyId: string | null | undefined; variant?: keyof typeof STYLE; onAct?: (a: NextAction) => void; className?: string }) {
  const a = useNextAction(companyId);
  if (!a || !companyId) return null;
  const body = <>{a.create ? <Sparkles size={13} aria-hidden /> : null}{a.label}{!a.create && <ArrowRight size={12} aria-hidden />}</>;
  const props = { className: cn(STYLE[variant], className), "data-next-action": a.step, "data-next-label": a.label };
  if (onAct && a.target.kind !== "project") return <button type="button" {...props} onClick={(e) => { e.stopPropagation(); onAct(a); }}>{body}</button>;
  return <Link href={actionHref(companyId, a)} {...props} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>{body}</Link>;
}
