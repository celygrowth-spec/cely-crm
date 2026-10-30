import "server-only";
import { requireOwner } from "@/lib/auth";
import { todayISO } from "@/lib/format";
import { loadFinance } from "@/lib/finance/service";
import { resolvePeriod, previousPeriod, addMonths, type Period } from "@/lib/finance/dates";

/** Données Finance de la page (échéances d'abonnement synchronisées, idempotent). */
export async function financeData() {
  const { supabase } = await requireOwner();
  return loadFinance(supabase, todayISO(), { sync: true });
}

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Période choisie dans l'URL (?p=mois|trimestre|annee|perso&ref=&du=&au=), mois en cours par défaut. */
export async function periodFrom(searchParams: SP, today: string) {
  const sp = await searchParams;
  const ref = one(sp.ref);
  const valid = ref && /^\d{4}-\d{2}-\d{2}$/.test(ref) ? ref : today;
  const p = resolvePeriod(one(sp.p), valid, one(sp.du), one(sp.au));
  const step = p.kind === "trimestre" ? 3 : p.kind === "annee" ? 12 : 1;
  const href = (base: string, x: Period) => (x.kind === "perso" ? `${base}?p=perso&du=${x.from}&au=${x.to}` : `${base}?p=${x.kind}&ref=${x.from}`);
  return {
    period: p,
    previous: previousPeriod(p),
    sp,
    one,
    prevHref: (base: string) => href(base, resolvePeriod(p.kind, addMonths(p.from, -step))),
    nextHref: (base: string) => href(base, resolvePeriod(p.kind, addMonths(p.from, step))),
    query: p.kind === "perso" ? `du=${p.from}&au=${p.to}` : `du=${p.from}&au=${p.to}`,
  };
}
