"use client";

// Clôturer une opportunité depuis la fiche ou le Kanban, avec la même logique :
//  * Gagné → « Marquer comme gagné » (sales/win-sale) : fiche Gagné, vente suivie, revenu, projet ;
//  * Perdu → motif facultatif (set_deal_status) ;
//  * Rouvrir → décision explicite si un projet ou un revenu est lié (liens conservés).
// Source de vérité : companies.deal_status ; l'étape reste la progression commerciale.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MoreHorizontal, RotateCcw, Trophy, X } from "lucide-react";
import { setDealStatusAction } from "@/app/actions";
import { stopRevenueAction } from "@/app/finance-actions";
import { attempt, useSync } from "@/lib/client/query";
import type { DealClosing, DealResult, DealStatus } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";
import { STAGE_LABELS, amountLine, needsCompletion } from "@/lib/sales/rules";
import type { RecordCtx } from "./company-record";
import { WinSaleDialog, useSale } from "./sales/win-sale";
import { Badge, Button, Field, Input, Modal, Skeleton, cn } from "./ui";

export type ClosingTarget = {
  id: string;
  name: string;
  deal_status: DealStatus;
  amount: number | null;
  deal_closed_at?: string | null;
  lost_reason?: string | null;
};

/** Où ouvrir la préparation de l'onboarding (point de raccordement avec le module Projets). */
export const onboardingHref = (companyId: string) => `/projets?nouveau=1&client=${companyId}`;

export const closedOnLabel = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(iso)) : null;

/**
 * Envoie la clôture et resynchronise tout ce qui lit deal_status : fiche, activité, Kanban, listes.
 * `send` peut être enveloppé par l'appelant (la fiche y ajoute sa mise à jour immédiate et son indicateur).
 */
export function useDealStatus() {
  const sync = useSync();
  return async (target: ClosingTarget, status: DealStatus, closing: DealClosing = {}) => {
    const r = await attempt(() => setDealStatusAction(target.id, status, closing));
    if (!r.ok) return r;
    sync(["company", target.id], ["company-timeline", target.id], ["companies"], ["pipeline-cards"], ["company-projects", target.id], ["sales"]);
    return r as { ok: true; data: DealResult };
  };
}

/** Confirmation compacte « Perdu » : motif facultatif. */
export function LoseForm({ target, busy, onConfirm, onCancel }: { target: ClosingTarget; busy: boolean; onConfirm: (c: DealClosing) => void; onCancel: () => void }) {
  const [reason, setReason] = useState(target.lost_reason ?? "");
  return (
    <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); onConfirm({ lostReason: reason.trim() || null }); }} data-lose-form>
      <p className="text-sm font-semibold">Opportunité perdue</p>
      <Field label="Motif (facultatif)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Budget, timing, concurrent…" aria-label="Motif de perte" autoFocus />
      </Field>
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="submit" size="sm" variant="danger" disabled={busy}><X size={13} /> Marquer perdu</Button>
      </div>
    </form>
  );
}

/** Ferme au clic extérieur et à Échap (sans fermer le panneau de la fiche derrière). */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return ref;
}

function Anchored({ open, children, panel, align = "left" }: { open: boolean; children: ReactNode; panel: ReactNode; align?: "left" | "right" }) {
  return (
    <div className="relative">
      {children}
      {open && (
        <div className={cn(
          "fade-in z-30 rounded-xl border border-line bg-white p-3 shadow-lg",
          // mobile : carte pleine largeur sous l'en-tête, jamais hors de l'écran ; ailleurs, ancrée au bouton
          "max-sm:fixed max-sm:inset-x-4 max-sm:top-40 sm:absolute sm:top-full sm:mt-1 sm:w-72",
          align === "right" ? "sm:right-0" : "sm:left-0",
        )}>
          {panel}
        </div>
      )}
    </div>
  );
}

type Run = (status: DealStatus, closing?: DealClosing) => Promise<boolean>;

/**
 * Rouvrir une vente clôturée : liens conservés (projet, revenu, factures). S'il y en a, la décision est
 * explicite ; un revenu mensuel peut être arrêté au passage, jamais sans le demander.
 */
function ReopenConfirm({ companyId, busy, onConfirm, onCancel }: { companyId: string; busy: boolean; onConfirm: (stopMissionId: string | null) => void; onCancel: () => void }) {
  const sale = useSale(companyId);
  const [stop, setStop] = useState(false);
  if (sale.isLoading) return <Skeleton className="h-16 w-full" />;
  const r = sale.data;
  const monthly = r?.mission_id && r.mission_kind === "recurrent" && r.mission_status !== "termine";
  const links = [r?.project_name && `le projet « ${r.project_name} »`, r?.mission_id && `le revenu ${amountLine(r) ?? ""}`.trim()].filter(Boolean) as string[];
  return (
    <div className="space-y-2.5 text-sm" data-reopen-confirm>
      <p className="font-semibold">Rouvrir l&apos;opportunité ?</p>
      {links.length ? (
        <p className="text-muted">Cette vente a {links.join(" et ")}. Ils restent liés et seront réutilisés si vous la regagnez.</p>
      ) : (
        <p className="text-muted">La fiche retrouve sa dernière étape dans Pipelines.</p>
      )}
      {monthly && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-violet-600" checked={stop} onChange={(e) => setStop(e.target.checked)} />
          <span>Arrêter aussi le revenu mensuel à partir d&apos;aujourd&apos;hui</span>
        </label>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onConfirm(stop && r?.mission_id ? r.mission_id : null)}>
          <RotateCcw size={13} /> {links.length ? "Rouvrir en conservant les liens" : "Rouvrir"}
        </Button>
      </div>
    </div>
  );
}

async function stopRevenue(missionId: string | null) {
  if (!missionId) return true;
  const r = await attempt(() => stopRevenueAction(missionId, todayISO()));
  if (!r.ok) toast.error(`Revenu non arrêté : ${r.error}`);
  return r.ok;
}

/**
 * Commandes de clôture dans l'en-tête de la fiche : « Gagné » / « Perdu » sur une opportunité ouverte ;
 * une fois clôturée, badge daté (détail, réouverture) et accès direct à l'endroit où reprendre le dossier.
 */
export function DealClosingControls({ target, run }: { target: ClosingTarget; run: Run }) {
  const router = useRouter();
  const [form, setForm] = useState<"lost" | "menu" | "reopen" | null>(null);
  const [win, setWin] = useState<null | "win" | "complete">(null);
  const [busy, setBusy] = useState(false);
  const sale = useSale(target.id);
  const ref = useDismiss(form !== null, () => setForm(null));
  const go = async (status: DealStatus, closing?: DealClosing) => {
    setBusy(true);
    const ok = await run(status, closing);
    setBusy(false);
    if (!ok) return;
    setForm(null);
    if (status === "lost") toast.success(`${target.name} : opportunité perdue`, { action: { label: "Voir dans Ventes", onClick: () => router.push("/ventes?vue=perdues") } });
    else if (status === "open") toast.success("Opportunité rouverte : retour à la dernière étape, liens conservés");
  };
  const winDialog = <WinSaleDialog company={{ id: target.id, name: target.name }} open={win !== null} complete={win === "complete"} onClose={() => setWin(null)} />;

  if (target.deal_status === "open") {
    return (
      <div ref={ref} className="flex items-center gap-1" data-deal-actions>
        <Button size="sm" onClick={() => setWin("win")} className="h-8 border-success/30 text-success hover:bg-success/5"><Trophy size={13} /> Gagné</Button>
        <Anchored open={form === "lost"} align="right" panel={<LoseForm target={target} busy={busy} onConfirm={(c) => void go("lost", c)} onCancel={() => setForm(null)} />}>
          <Button size="sm" onClick={() => setForm(form === "lost" ? null : "lost")} aria-expanded={form === "lost"} className="h-8 text-muted hover:text-danger"><X size={13} /> Perdu</Button>
        </Anchored>
        {winDialog}
      </div>
    );
  }

  const won = target.deal_status === "won";
  const date = closedOnLabel(target.deal_closed_at);
  const s = sale.data;
  return (
    <div ref={ref} className="flex items-center gap-1" data-deal-outcome={target.deal_status}>
      <Anchored open={form === "menu" || form === "reopen"} panel={
        form === "reopen" ? (
          <ReopenConfirm companyId={target.id} busy={busy} onCancel={() => setForm(null)} onConfirm={async (stopId) => { if (await stopRevenue(stopId)) await go("open"); }} />
        ) : (
          <div className="space-y-2 text-sm">
            <p>{won ? <>Gagné{date ? ` le ${date}` : ""}{s && amountLine(s) ? ` · ${amountLine(s)}` : ""}</> : <>Perdu{date ? ` le ${date}` : ""}{target.lost_reason ? ` : ${target.lost_reason}` : ""}</>}</p>
            {won && s?.signed_on && <p className="text-xs text-muted">Signé le {closedOnLabel(s.signed_on)}</p>}
            <div className="flex flex-wrap gap-1.5">
              <Link href={won ? "/ventes" : "/ventes?vue=perdues"} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-semibold hover:bg-surface">Voir dans Ventes <ArrowRight size={12} /></Link>
              <Button size="sm" disabled={busy} onClick={() => setForm("reopen")}><RotateCcw size={13} /> Rouvrir l&apos;opportunité</Button>
            </div>
          </div>
        )
      }>
        <button type="button" onClick={() => setForm(form ? null : "menu")} aria-expanded={form !== null} aria-label={`${won ? "Gagné" : "Perdu"} : détails et réouverture`}>
          <Badge tone={won ? "success" : "danger"} className="h-8 px-2.5 text-xs">
            {won ? <Trophy size={12} /> : <X size={12} />} {won ? "Gagné" : "Perdu"}{date && <span className="font-normal max-sm:hidden"> · {date}</span>}
          </Badge>
        </button>
      </Anchored>
      {won && s && needsCompletion(s) && (
        <Button size="sm" className="h-8" onClick={() => setWin("complete")} data-complete-sale>Compléter le suivi</Button>
      )}
      {won && s?.sale_id && s.stage && s.stage !== "termine" && (
        <Link href="/ventes" className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:border-violet" data-sale-stage>
          {STAGE_LABELS[s.stage]} <ArrowRight size={12} className="text-muted" />
        </Link>
      )}
      {winDialog}
    </div>
  );
}

/** Menu compact d'une carte du Kanban : mêmes clôtures que la fiche, mêmes confirmations. */
export function CardClosingMenu({ target, onChanged }: { target: ClosingTarget; onChanged: (status: DealStatus) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<"lost" | "reopen" | null>(null);
  const [win, setWin] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const send = useDealStatus();
  const go = async (status: DealStatus, closing?: DealClosing) => {
    setBusy(true);
    const r = await send(target, status, closing);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setForm(null);
    setOpen(false);
    onChanged(status);
    if (status === "lost") toast.success(`${target.name} : opportunité perdue`, { action: { label: "Voir dans Ventes", onClick: () => router.push("/ventes?vue=perdues") } });
    else toast.success(`${target.name} : opportunité rouverte`);
  };
  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface";
  return (
    <div ref={ref} className="relative" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(!open)} aria-label={`Clôturer ${target.name}`} aria-expanded={open} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="fade-in absolute top-full right-0 z-30 mt-1 w-52 rounded-xl border border-line bg-white p-1 shadow-lg" role="menu">
          {target.deal_status === "open" ? (
            <>
              <button type="button" role="menuitem" className={cn(item, "text-success")} onClick={() => { setOpen(false); setWin(true); }}><Trophy size={14} /> Gagné</button>
              <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => { setOpen(false); setForm("lost"); }}><X size={14} /> Perdu</button>
            </>
          ) : (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => { setOpen(false); setForm("reopen"); }}><RotateCcw size={14} /> Rouvrir l&apos;opportunité</button>
          )}
        </div>
      )}
      <Modal open={form !== null} onClose={() => setForm(null)} title={target.name}>
        {form === "lost" && <LoseForm target={target} busy={busy} onConfirm={(c) => void go("lost", c)} onCancel={() => setForm(null)} />}
        {form === "reopen" && <ReopenConfirm companyId={target.id} busy={busy} onCancel={() => setForm(null)} onConfirm={async (stopId) => { if (await stopRevenue(stopId)) await go("open"); }} />}
      </Modal>
      <WinSaleDialog company={{ id: target.id, name: target.name }} open={win} onClose={() => setWin(false)} onDone={() => onChanged("won")} />
    </div>
  );
}

/** L'issue de l'opportunité, à côté de l'étape : même logique que le Kanban et Ventes. */
export function RecordDealClosing({ ctx }: { ctx: RecordCtx }) {
  const c = ctx.detail.company;
  const send = useDealStatus();
  const target = { id: c.id, name: c.name, deal_status: c.deal_status, amount: c.amount, deal_closed_at: c.deal_closed_at, lost_reason: c.lost_reason };
  return (
    <DealClosingControls
      target={target}
      run={(status, closing = {}) => {
        const optimistic = {
          deal_status: status,
          deal_closed_at: status === "open" ? null : new Date().toISOString(),
          ...(status === "lost" ? { lost_reason: closing.lostReason ?? null } : {}),
        };
        return ctx.mutate(optimistic, async () => {
          const r = await send(target, status, closing);
          return r.ok ? { ok: true } : r;
        });
      }}
    />
  );
}
