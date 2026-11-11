"use client";

// Ventes : où en est chaque client après la signature. Pipelines garde les opportunités ouvertes ;
// une fiche gagnée ou perdue arrive ici, avec la même fiche, ses contacts et son historique.
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, ExternalLink, FileText, FolderKanban, Loader2, MoreHorizontal, RotateCcw } from "lucide-react";
import { retryPrepAction } from "@/app/sales-actions";
import { moveSaleStage } from "@/components/sales/project-sale-panel";
import { useCrm } from "@/components/app-shell";
import { WinSaleDialog, useSaleSync, useSales } from "@/components/sales/win-sale";
import { Badge, Button, EmptyState, Modal, PageHeader, Select, cn } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { todayISO } from "@/lib/format";
import {
  BILLING_TONES, billingLabel, PERIODS, STAGE_LABELS, amountLine, board, byClosedDesc, inPeriod, metrics, missingCount, needsCompletion,
  type Period, type SaleRow, type SaleStage,
} from "@/lib/sales/rules";

export type SalesTab = "suivi" | "gagnees" | "perdues";

const dayLabel = (d: string | null) => (d ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00`)) : "—");

export function SalesView({ initial, tab: initialTab, period: initialPeriod }: { initial: SaleRow[]; tab: SalesTab; period: Period }) {
  const { data: rows = [] } = useSales(initial);
  // vue et période vivent côté navigateur (données déjà chargées) ; l'adresse suit, sans rechargement
  const [tab, setTab] = useState<SalesTab>(initialTab);
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const today = todayISO();
  const m = metrics(rows, period, today);
  const won = rows.filter((r) => r.deal_status === "won" && inPeriod(r, period, today)).sort(byClosedDesc);
  const lost = rows.filter((r) => r.deal_status === "lost" && inPeriod(r, period, today)).sort(byClosedDesc);
  const toComplete = rows.filter(needsCompletion);
  const go = (t: SalesTab, p = period) => {
    setTab(t);
    setPeriod(p);
    const q = new URLSearchParams({ ...(t !== "suivi" ? { vue: t } : {}), ...(p !== "annee" ? { periode: p } : {}) }).toString();
    window.history.replaceState(null, "", `/ventes${q ? `?${q}` : ""}`);
  };

  return (
    <div>
      <PageHeader title="Ventes" description="Les opportunités gagnées et perdues. Les opportunités ouvertes restent dans Pipelines."
        actions={
          <Select value={period} onChange={(e) => go(tab, e.target.value as Period)} className="w-auto" aria-label="Période">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Select>
        } />

      <div className="mb-4 grid grid-cols-3 gap-2 sm:max-w-xl" data-sales-metrics>
        <Metric label="Gagnées" value={String(m.won)} />
        <Metric label="Perdues" value={String(m.lost)} />
        <Metric label="Taux de réussite" value={m.rate == null ? "—" : `${m.rate} %`} hint={m.rate == null ? "Aucune vente clôturée sur la période" : `${m.won} sur ${m.won + m.lost}`} />
      </div>

      <nav role="tablist" aria-label="Vues des ventes" className="mb-4 flex gap-1 border-b border-line">
        {([["suivi", "Suivi clients"], ["gagnees", `Gagnées (${won.length})`], ["perdues", `Perdues (${lost.length})`]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => go(k)}
            className={cn("-mb-px border-b-2 px-3 py-2 font-label text-sm font-semibold whitespace-nowrap", tab === k ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink")}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "suivi" && <Board rows={rows} toComplete={toComplete} onShowWon={() => go("gagnees", "tout")} />}
      {tab === "gagnees" && <WonList rows={won} />}
      {tab === "perdues" && <LostList rows={lost} />}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white px-3 py-2" title={hint}>
      <p className="font-label text-xs font-semibold text-muted">{label}</p>
      <p className="font-display text-xl font-extrabold text-ink">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suivi clients : tableau après-vente (indépendant de la période)
// ---------------------------------------------------------------------------

function Board({ rows, toComplete, onShowWon }: { rows: SaleRow[]; toComplete: SaleRow[]; onShowWon: () => void }) {
  const cols = board(rows);
  const empty = cols.every((c) => !c.rows.length);
  return (
    <div className="space-y-3">
      {toComplete.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-to-complete>
          <AlertTriangle size={14} className="text-warning" />
          {toComplete.length} ancienne{toComplete.length > 1 ? "s" : ""} vente{toComplete.length > 1 ? "s" : ""} gagnée{toComplete.length > 1 ? "s" : ""} sans suivi : complétez-les pour les retrouver ici.
          <button type="button" className="font-semibold text-violet-strong hover:underline" onClick={onShowWon}>Voir les ventes gagnées</button>
        </p>
      )}
      {empty && !toComplete.length && <EmptyState title="Aucun client en cours de suivi" description="Marquez une opportunité « Gagné » depuis sa fiche ou depuis Pipelines : elle apparaîtra ici." />}
      <div className="grid gap-3 md:grid-cols-3" data-sales-board>
        {cols.map((c) => (
          <section key={c.key} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-2" aria-label={c.label} data-col={c.key}>
            <header className="mb-2 px-1">
              <p className="font-label text-sm font-bold">{c.label} <span className="font-normal text-muted">{c.rows.length}</span></p>
              <p className="text-xs text-muted">{c.hint}</p>
            </header>
            <div className="flex min-h-20 flex-col gap-2">
              {c.rows.map((r) => <SaleCard key={r.row_id} r={r} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SaleCard({ r }: { r: SaleRow }) {
  const { openCompany } = useCrm();
  const saleSync = useSaleSync();
  const [menu, setMenu] = useState(false);
  const [finalise, setFinalise] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const amount = amountLine(r);
  const missing = missingCount(r);
  const projectHref = r.project_id ? `/projets/${r.project_id}` : null;

  async function stage(s: SaleStage) {
    if (!r.sale_id) return;
    setBusy(true);
    const res = await moveSaleStage(r.sale_id!, s);
    setBusy(false);
    setMenu(false);
    if (!res) return;
    if (!res.ok) return void toast.error(res.error);
    saleSync(r.company_id);
    toast.success(`${r.name} : ${STAGE_LABELS[s]}`);
  }
  async function retry() {
    if (!r.project_id) return;
    setBusy(true);
    const res = await attempt(() => retryPrepAction(r.project_id!));
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    saleSync(r.company_id);
  }

  // une seule action principale, selon la colonne
  const primary = r.stage === "devis_contrat"
    ? <Button size="sm" variant="primary" onClick={() => setFinalise(true)}><FileText size={13} /> Finaliser le dossier</Button>
    : projectHref
      ? <Link href={projectHref} className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink px-3 text-xs font-semibold text-white hover:bg-violet-strong">
          {r.stage === "onboarding" ? "Ouvrir l'onboarding" : "Ouvrir le projet"} <ArrowRight size={12} />
        </Link>
      : <Button size="sm" variant="primary" onClick={() => setComplete(true)}>Lier un projet</Button>;

  return (
    <article className="row-in rounded-lg border border-line bg-white p-2.5 shadow-xs" data-sale-card={r.company_id} data-sale={r.sale_id ?? undefined}>
      <div className="flex items-start gap-1">
        <button type="button" onClick={() => openCompany(r.company_id, { name: r.name })} className="min-w-0 flex-1 text-left">
          <p className="truncate font-semibold">{r.name}</p>
          {amount && <p className="truncate text-xs text-ink" data-amount>{amount}</p>}
        </button>
        <div className="relative">
          <button type="button" aria-label={`Actions pour ${r.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink"><MoreHorizontal size={15} /></button>
          {menu && (
            <div className="fade-in absolute top-full right-0 z-30 mt-1 w-56 rounded-xl border border-line bg-white p-1 text-sm shadow-lg" role="menu" onMouseLeave={() => setMenu(false)}>
              {r.stage !== "devis_contrat" && r.sale_id && <MenuBtn onClick={() => void stage("devis_contrat")} disabled={busy}>Revenir en Devis / Contrat</MenuBtn>}
              {r.stage !== "onboarding" && r.sale_id && <MenuBtn onClick={() => void stage("onboarding")} disabled={busy}>Passer en Onboarding</MenuBtn>}
              {r.stage !== "en_mission" && r.project_id && r.sale_id && <MenuBtn onClick={() => void stage("en_mission")} disabled={busy}>Démarrer la mission</MenuBtn>}
              {r.stage === "en_mission" && r.sale_id && <MenuBtn onClick={() => void stage("termine")} disabled={busy}>Terminer la mission</MenuBtn>}
              <div className="my-1 border-t border-line" />
              {r.mission_id ? (
                <Link role="menuitem" href={`/finance/revenus?revenu=${r.mission_id}`} className="block rounded-lg px-2.5 py-2 hover:bg-surface">Préparer la facture</Link>
              ) : null}
              <MenuBtn onClick={() => { setMenu(false); setComplete(true); }}>{r.mission_id ? "Lier une facture" : "Renseigner le revenu"}</MenuBtn>
            </div>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Badge tone={BILLING_TONES[r.billing]}>{billingLabel(r)}</Badge>
        {r.billing === "a_renseigner" && (
          <button type="button" onClick={() => setComplete(true)} className="text-xs font-semibold text-violet-strong hover:underline" data-fill-billing>Renseigner</button>
        )}
      </div>
      <PrepLine r={r} missing={missing} busy={busy} onRetry={() => void retry()} />
      <div className="mt-2 flex items-center justify-between gap-2">
        {primary}
        {projectHref && r.stage !== "onboarding" && r.stage !== "en_mission" && (
          <Link href={projectHref} className="inline-flex items-center gap-1 truncate text-xs text-muted hover:text-ink" title={r.project_name ?? undefined}><FolderKanban size={12} /> Projet</Link>
        )}
      </div>
      <FinaliseDialog r={r} open={finalise} onClose={() => setFinalise(false)} onReady={() => { setFinalise(false); void stage("onboarding"); }} />
      <WinSaleDialog company={{ id: r.company_id, name: r.name }} open={complete} complete onClose={() => setComplete(false)} />
    </article>
  );
}

function MenuBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-surface disabled:opacity-50">{children}</button>;
}

/** État de la préparation (même source que Projets) : en cours, éléments à compléter, interrompue. */
function PrepLine({ r, missing, busy, onRetry }: { r: SaleRow; missing: number; busy: boolean; onRetry: () => void }) {
  if (!r.sale_id || !r.project_id || !r.prep_status) return null;
  if (r.prep_error)
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-danger" data-prep="failed">
        <AlertTriangle size={12} /> Préparation interrompue : {r.prep_error}.
        <span className="text-muted">Vente{r.mission_id ? ", revenu" : ""} et projet déjà enregistrés.</span>
        <button type="button" disabled={busy} onClick={onRetry} className="inline-flex items-center gap-0.5 font-semibold text-violet-strong hover:underline"><RotateCcw size={11} /> Reprendre</button>
      </p>
    );
  if (r.prep_status === "preparing")
    return <p className="mt-1.5 flex items-center gap-1 text-xs text-muted" data-prep="running"><Loader2 size={12} className="animate-spin" /> Préparation du projet…</p>;
  if (missing > 0)
    return <Link href={`/projets/${r.project_id}`} className="mt-1.5 block text-xs font-semibold text-warning hover:underline" data-prep="incomplete">{missing} élément{missing > 1 ? "s" : ""} à compléter</Link>;
  if (r.prep_status === "ready" && r.stage === "onboarding") return <p className="mt-1.5 text-xs text-success" data-prep="ready">Prêt pour l&apos;onboarding</p>;
  return null;
}

/** Devis / Contrat : un fichier « Contrat » est une pièce à examiner ; seule votre confirmation vaut signature. */
function FinaliseDialog({ r, open, onClose, onReady }: { r: SaleRow; open: boolean; onClose: () => void; onReady: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={`Finaliser le dossier · ${r.name}`}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Formalités après la vente : devis signé, contrat, bon de commande. Rangez les pièces dans les documents de la fiche (catégories « Proposition » et « Contrat ») : elles y sont à examiner ; ajouter un fichier ne vaut pas signature.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-violet-600" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>J&apos;ai vérifié : le devis ou le contrat est accepté et signé.</span>
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={`/fiches/${r.company_id}`} className="inline-flex h-9 items-center gap-1 rounded-lg border border-line px-3 font-semibold hover:bg-surface">Documents de la fiche <ExternalLink size={12} /></Link>
          <Button variant="primary" onClick={onReady} disabled={!r.sale_id || !checked}>Confirmer : passer en Onboarding</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Listes Gagnées / Perdues (période choisie)
// ---------------------------------------------------------------------------

function WonList({ rows }: { rows: SaleRow[] }) {
  const { openCompany } = useCrm();
  const [complete, setComplete] = useState<SaleRow | null>(null);
  if (!rows.length) return <EmptyState title="Aucune vente gagnée sur la période" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[720px] text-sm" data-won-list>
        <thead className="bg-surface text-left text-xs text-muted">
          <tr><th className="px-3 py-2">Client</th><th className="px-3 py-2">Clôturée le</th><th className="px-3 py-2">Montant</th><th className="px-3 py-2">Projet</th><th className="px-3 py-2">Facturation</th><th className="px-3 py-2">Suivi</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.row_id} className="hover:bg-surface/60">
              <td className="px-3 py-2"><button type="button" onClick={() => openCompany(r.company_id, { name: r.name })} className="font-semibold hover:underline">{r.name}</button>{(r.cycle ?? 1) > 1 && <span className="ml-1 text-xs text-muted">· vente n° {r.cycle}</span>}</td>
              <td className="px-3 py-2 whitespace-nowrap">{dayLabel(r.closed_on)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{amountLine(r) ?? <span className="text-muted">—</span>}{r.mission_status === "termine" && <span className="ml-1 text-xs text-muted">(revenu arrêté)</span>}</td>
              <td className="px-3 py-2">{r.project_id ? <Link href={`/projets/${r.project_id}`} className="hover:underline">{r.project_name}</Link> : <span className="text-muted">—</span>}</td>
              <td className="px-3 py-2"><Badge tone={BILLING_TONES[r.billing]}>{billingLabel(r)}</Badge></td>
              <td className="px-3 py-2">
                {needsCompletion(r)
                  ? <Button size="sm" onClick={() => setComplete(r)} data-complete={r.company_id}>Compléter</Button>
                  : r.stage ? <Badge tone={r.stage === "termine" ? "neutral" : "violet"}>{STAGE_LABELS[r.stage]}</Badge> : <span className="text-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {complete && <WinSaleDialog company={{ id: complete.company_id, name: complete.name }} open complete onClose={() => setComplete(null)} />}
    </div>
  );
}

function LostList({ rows }: { rows: SaleRow[] }) {
  const { openCompany } = useCrm();
  if (!rows.length) return <EmptyState title="Aucune vente perdue sur la période" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[600px] text-sm" data-lost-list>
        <thead className="bg-surface text-left text-xs text-muted">
          <tr><th className="px-3 py-2">Client</th><th className="px-3 py-2">Perdue le</th><th className="px-3 py-2">Dernière étape</th><th className="px-3 py-2">Motif</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.row_id} className="hover:bg-surface/60">
              <td className="px-3 py-2"><button type="button" onClick={() => openCompany(r.company_id, { name: r.name })} className="font-semibold hover:underline">{r.name}</button></td>
              <td className="px-3 py-2 whitespace-nowrap">{dayLabel(r.closed_on)}</td>
              <td className="px-3 py-2">{r.stage_name ? `${r.pipeline_name} › ${r.stage_name}` : <span className="text-muted">—</span>}</td>
              <td className="px-3 py-2">{r.lost_reason ?? <span className="text-muted">Non renseigné</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
