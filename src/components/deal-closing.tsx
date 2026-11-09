"use client";

// Clôturer une opportunité : Gagné (date de signature, montant facultatif), Perdu (motif facultatif), Rouvrir.
// Une seule logique pour la fiche et le Kanban : setDealStatusAction → set_deal_status (source de vérité :
// companies.deal_status ; l'étape reste la progression commerciale).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Briefcase, Check, MoreHorizontal, RotateCcw, Trophy, X } from "lucide-react";
import { setDealStatusAction } from "@/app/actions";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { DealClosing, DealResult, DealStatus } from "@/lib/crm/service";
import { formatAmount, todayISO } from "@/lib/format";
import type { Project } from "@/lib/projects/types";
import type { RecordCtx } from "./company-record";
import { CreateProjectModal } from "./projects/create-project";
import { Badge, Button, Field, Input, Modal, cn } from "./ui";

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

const parseAmount = (v: string) => {
  const t = v.replace(/\s| |€/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};

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
    sync(["company", target.id], ["company-timeline", target.id], ["companies"], ["pipeline-cards"], ["company-projects", target.id]);
    return r as { ok: true; data: DealResult };
  };
}

/** Confirmation compacte « Gagné » : date de signature (aujourd'hui, modifiable) et montant facultatif. */
export function WinForm({ target, busy, onConfirm, onCancel }: { target: ClosingTarget; busy: boolean; onConfirm: (c: DealClosing) => void; onCancel: () => void }) {
  const today = todayISO();
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(target.amount != null ? String(target.amount).replace(".", ",") : "");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const n = parseAmount(amount);
    if (Number.isNaN(n)) return setError("Montant invalide");
    if (!date) return setError("Indiquez la date de signature");
    if (date > today) return setError("La date de signature ne peut pas être dans le futur");
    onConfirm({ closedOn: date, amount: n });
  };
  return (
    <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); submit(); }} data-win-form>
      <p className="text-sm font-semibold">Le client a signé ?</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Signé le">
          <Input type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setError(null); }} aria-label="Date de signature" autoFocus />
        </Field>
        <Field label="Montant (facultatif)">
          <Input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} placeholder="€" aria-label="Montant signé" />
        </Field>
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy}><Check size={13} /> Marquer gagné</Button>
      </div>
    </form>
  );
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
 * Commandes de clôture dans l'en-tête de la fiche : « Gagné » / « Perdu » sur une opportunité ouverte,
 * badge daté et « Rouvrir l'opportunité » une fois clôturée, « Préparer l'onboarding » une fois gagnée.
 */
export function DealClosingControls({ target, run, hasProject }: { target: ClosingTarget; run: Run; hasProject: boolean }) {
  const [form, setForm] = useState<"won" | "lost" | "menu" | null>(null);
  const [busy, setBusy] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const ref = useDismiss(form !== null, () => setForm(null));
  const go = async (status: DealStatus, closing?: DealClosing) => {
    setBusy(true);
    const ok = await run(status, closing);
    setBusy(false);
    if (!ok) return;
    setForm(null);
    if (status === "won") {
      toast.success(`${target.name} : opportunité gagnée`, hasProject ? undefined : { action: { label: "Préparer l'onboarding", onClick: () => setOnboarding(true) }, duration: 8000 });
    } else if (status === "lost") toast.success(`${target.name} : opportunité perdue`);
    else toast.success(hasProject ? "Opportunité rouverte : retour à la dernière étape, projet conservé" : "Opportunité rouverte : retour à la dernière étape");
  };

  if (target.deal_status === "open") {
    return (
      <div ref={ref} className="flex items-center gap-1" data-deal-actions>
        <Anchored open={form === "won"} panel={<WinForm target={target} busy={busy} onConfirm={(c) => void go("won", c)} onCancel={() => setForm(null)} />}>
          <Button size="sm" onClick={() => setForm(form === "won" ? null : "won")} aria-expanded={form === "won"} className="h-8 border-success/30 text-success hover:bg-success/5"><Trophy size={13} /> Gagné</Button>
        </Anchored>
        <Anchored open={form === "lost"} align="right" panel={<LoseForm target={target} busy={busy} onConfirm={(c) => void go("lost", c)} onCancel={() => setForm(null)} />}>
          <Button size="sm" onClick={() => setForm(form === "lost" ? null : "lost")} aria-expanded={form === "lost"} className="h-8 text-muted hover:text-danger"><X size={13} /> Perdu</Button>
        </Anchored>
      </div>
    );
  }

  const won = target.deal_status === "won";
  const date = closedOnLabel(target.deal_closed_at);
  return (
    <div ref={ref} className="flex items-center gap-1" data-deal-outcome={target.deal_status}>
      <Anchored open={form === "menu"} panel={
        <div className="space-y-2 text-sm">
          <p>{won ? <>Signé{date ? ` le ${date}` : ""}{target.amount != null ? ` · ${formatAmount(target.amount)}` : ""}</> : <>Perdu{date ? ` le ${date}` : ""}{target.lost_reason ? ` : ${target.lost_reason}` : ""}</>}</p>
          {hasProject && <p className="text-xs text-muted">Un projet est lié à cette fiche : il est conservé si vous rouvrez l&apos;opportunité.</p>}
          <Button size="sm" disabled={busy} onClick={() => void go("open")}><RotateCcw size={13} /> Rouvrir l&apos;opportunité</Button>
        </div>
      }>
        <button type="button" onClick={() => setForm(form === "menu" ? null : "menu")} aria-expanded={form === "menu"} aria-label={`${won ? "Gagné" : "Perdu"} : détails et réouverture`}>
          <Badge tone={won ? "success" : "danger"} className="h-8 px-2.5 text-xs">
            {won ? <Trophy size={12} /> : <X size={12} />} {won ? "Gagné" : "Perdu"}{date && <span className="font-normal max-sm:hidden"> · {date}</span>}
          </Badge>
        </button>
      </Anchored>
      {won && !hasProject && (
        <Button size="sm" className="h-8" onClick={() => setOnboarding(true)}><Briefcase size={13} /> <span className="max-sm:hidden">Préparer l&apos;onboarding</span><span className="sm:hidden">Onboarding</span></Button>
      )}
      <CreateProjectModal open={onboarding} onClose={() => setOnboarding(false)} company={{ id: target.id, name: target.name }} />
    </div>
  );
}

/** Menu compact d'une carte du Kanban : mêmes clôtures que la fiche, mêmes confirmations. */
export function CardClosingMenu({ target, onChanged }: { target: ClosingTarget; onChanged: (status: DealStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<"won" | "lost" | null>(null);
  const [busy, setBusy] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
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
    if (status === "won") toast.success(`${target.name} : opportunité gagnée`, { action: { label: "Préparer l'onboarding", onClick: () => setOnboarding(true) }, duration: 8000 });
    else if (status === "lost") toast.success(`${target.name} : opportunité perdue`);
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
              <button type="button" role="menuitem" className={cn(item, "text-success")} onClick={() => { setOpen(false); setForm("won"); }}><Trophy size={14} /> Gagné</button>
              <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => { setOpen(false); setForm("lost"); }}><X size={14} /> Perdu</button>
            </>
          ) : (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void go("open")}><RotateCcw size={14} /> Rouvrir l&apos;opportunité</button>
          )}
        </div>
      )}
      <Modal open={form !== null} onClose={() => setForm(null)} title={target.name}>
        {form === "won" && <WinForm target={target} busy={busy} onConfirm={(c) => void go("won", c)} onCancel={() => setForm(null)} />}
        {form === "lost" && <LoseForm target={target} busy={busy} onConfirm={(c) => void go("lost", c)} onCancel={() => setForm(null)} />}
      </Modal>
      <CreateProjectModal open={onboarding} onClose={() => setOnboarding(false)} company={{ id: target.id, name: target.name }} />
    </div>
  );
}

/** L'issue de l'opportunité, à côté de l'étape : même logique que le Kanban (useDealStatus). */
export function RecordDealClosing({ ctx }: { ctx: RecordCtx }) {
  const c = ctx.detail.company;
  const send = useDealStatus();
  const projects = useQuery({ queryKey: ["company-projects", c.id], queryFn: ({ signal }) => apiGet<Project[]>(`/api/fiches/${c.id}/projets`, signal) });
  const target = { id: c.id, name: c.name, deal_status: c.deal_status, amount: c.amount, deal_closed_at: c.deal_closed_at, lost_reason: c.lost_reason };
  return (
    <DealClosingControls
      target={target}
      hasProject={(projects.data ?? []).some((p) => p.status !== "archive")}
      run={(status, closing = {}) => {
        const at = status === "open" ? null : status === "won" && closing.closedOn && closing.closedOn !== new Date().toISOString().slice(0, 10) ? `${closing.closedOn}T12:00:00` : new Date().toISOString();
        const optimistic = {
          deal_status: status,
          deal_closed_at: at,
          ...(status === "won" && closing.amount != null ? { amount: closing.amount } : {}),
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
