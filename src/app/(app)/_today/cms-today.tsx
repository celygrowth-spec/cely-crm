"use client";

// Aujourd'hui › Site : publications du jour, des 7 prochains jours, et rafraîchissements du site en échec
// (repris automatiquement ; « Réessayer » les renvoie tout de suite).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { retryRefreshAction } from "@/app/cms-actions";
import { Badge, Button } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis, parisDay } from "@/lib/cms/dates";
import type { CmsFailure, CmsTodayItem } from "@/lib/cms/service";
import { STATUS_LABEL, STATUS_TONE, effectiveStatus } from "@/lib/cms/types";

export function CmsToday({ publications, failures, today }: { publications: CmsTodayItem[]; failures: CmsFailure[]; today: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const todays = publications.filter((p) => parisDay(p.publish_at!) === today);
  const next = publications.filter((p) => parisDay(p.publish_at!) > today);

  async function retry() {
    setBusy(true);
    const r = await attempt(() => retryRefreshAction());
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.failed) toast.error("Le site n'a toujours pas répondu : nouvel essai automatique.");
    else toast.success("Site rafraîchi");
    router.refresh();
  }

  const Row = ({ p }: { p: CmsTodayItem }) => {
    const s = effectiveStatus(p);
    return (
      <li>
        <Link href={`/cms/articles/${p.id}`} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-violet-soft/30">
          <span className="min-w-0 flex-1 truncate"><strong>{p.title}</strong></span>
          <span className="shrink-0 text-xs text-muted">{formatParis(p.publish_at)}</span>
          <Badge tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Badge>
        </Link>
      </li>
    );
  };

  return (
    <div className="space-y-3" data-home-cms>
      {failures.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm" data-home-cms-failures>
          <div className="flex items-center gap-2">
            <strong className="flex-1 text-danger">Le site n&apos;a pas pu être rafraîchi ({failures.length})</strong>
            <Button size="sm" onClick={() => void retry()} disabled={busy} data-cms-retry>{busy ? "Envoi…" : "Réessayer"}</Button>
          </div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {failures.slice(0, 5).map((f) => (
              <li key={f.id}>{f.reasons.slice(-2).join(", ") || "Rafraîchissement"} — {f.last_error ?? "échec"} · {f.attempts} essai(s), prochain {formatParis(f.next_attempt_at)}</li>
            ))}
          </ul>
        </div>
      )}
      <section>
        <h3 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">Publications du jour · {todays.length}</h3>
        {todays.length ? <ul className="divide-y divide-line rounded-xl border border-line" data-home-cms-today>{todays.map((p) => <Row key={p.id} p={p} />)}</ul> : <p className="text-sm text-muted">Aucune publication aujourd&apos;hui.</p>}
      </section>
      <section>
        <h3 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">7 prochains jours · {next.length}</h3>
        {next.length ? <ul className="divide-y divide-line rounded-xl border border-line" data-home-cms-next>{next.map((p) => <Row key={p.id} p={p} />)}</ul> : <p className="text-sm text-muted">Rien de programmé.</p>}
      </section>
    </div>
  );
}
