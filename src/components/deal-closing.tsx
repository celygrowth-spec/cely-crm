"use client";

// Clôturer une opportunité depuis la fiche ou le Kanban, avec la même logique :
//  * Gagné → « Marquer comme gagné » (sales/win-sale) : fiche Gagné, vente suivie, revenu, projet ;
//  * Perdu / Rouvrir → deal_transition : si un projet, un revenu ou des accès client sont liés, vous décidez de
//    leur sort (projet, échéances futures, portail) et tout s'applique en une opération (C03) ;
//  * Nouvelle opportunité → client qui revient : nouvelle vente sur la même fiche (Q05).
// Source de vérité : companies.deal_status ; une fiche clôturée ne change pas d'étape sans réouverture (C01).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { ArrowRight, MoreHorizontal, Plus, RotateCcw, Trophy, X } from "lucide-react";
import { setDealStatusAction } from "@/app/actions";
import { dealLinksAction, dealTransitionAction, newOpportunityAction } from "@/app/sales-actions";
import { attempt, useSync } from "@/lib/client/query";
import type { DealClosing, DealResult, DealStatus } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";
import { STAGE_LABELS, amountLine, needsCompletion } from "@/lib/sales/rules";
import type { TransitionOptions } from "@/lib/sales/service";
import { useCrm } from "./app-shell";
import type { RecordCtx } from "./company-record";
import { WinSaleDialog, useSale } from "./sales/win-sale";
import { Badge, Button, Field, Input, Modal, Select, Skeleton, cn } from "./ui";

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

/**
 * Rouvrir ou perdre : montre ce qui est lié (projet, revenu, accès client) et demande ce que chacun devient.
 * Les factures et règlements gardent toujours leur historique. Tout s'applique en une opération, ou rien.
 */
export function TransitionForm({ target, status, onDone, onCancel }: { target: ClosingTarget; status: "open" | "lost"; onDone: () => void; onCancel: () => void }) {
  const sync = useSync();
  const links = useQuery({
    queryKey: ["deal-links", target.id],
    queryFn: async () => { const r = await dealLinksAction(target.id); if (!r.ok) throw new Error(r.error); return r.data; },
    staleTime: 0,
  });
  const [reason, setReason] = useState(target.lost_reason ?? "");
  const [project, setProject] = useState<NonNullable<TransitionOptions["project"]>>(status === "lost" ? "archive" : "continue");
  const [revenue, setRevenue] = useState<NonNullable<TransitionOptions["revenue"]>>(status === "lost" ? "stop" : "continue");
  const [stopOn, setStopOn] = useState(todayISO());
  const [portal, setPortal] = useState<NonNullable<TransitionOptions["portal"]>>(status === "lost" ? "revoke" : "keep");
  const [key] = useState(() => `transition-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (links.isLoading) return <Skeleton className="h-20 w-full" />;
  if (links.isError) return <p className="text-sm text-danger">{links.error.message}</p>;
  const l = links.data;
  const activeProject = l?.project && !["termine", "archive"].includes(l.project.status) ? l.project : null;
  const activeMission = l?.mission && l.mission.status !== "termine" ? l.mission : null;
  const people = l?.portal_people ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await attempt(() => dealTransitionAction(target.id, status, {
      ...(activeProject ? { project } : {}), ...(activeMission ? { revenue, revenue_stop_on: stopOn } : {}),
      ...(people.length ? { portal } : {}), ...(status === "lost" ? { lost_reason: reason.trim() || null } : {}),
    }, key));
    setBusy(false);
    if (!r.ok) return setError(r.error); // la saisie reste : rien n'a été changé
    sync(["company", target.id], ["company-timeline", target.id], ["companies"], ["pipeline-cards"], ["company-projects", target.id], ["sales"], ["deal-links", target.id]);
    const effects = r.data.effects.length ? ` · ${r.data.effects.join(" · ")}` : "";
    toast.success(`${target.name} : ${status === "open" ? "opportunité rouverte" : "opportunité perdue"}${effects}`);
    onDone();
  }
  const radio = <T extends string>(name: string, value: T, current: T, set: (v: T) => void, label: string) => (
    <label className="flex items-center gap-1.5"><input type="radio" name={name} className="accent-violet-600" checked={current === value} onChange={() => set(value)} /> {label}</label>
  );
  return (
    <form className="space-y-2.5 text-sm" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-transition={status}>
      <p className="font-semibold">{status === "open" ? "Rouvrir l'opportunité" : "Opportunité perdue"}</p>
      {status === "lost" && (
        <Field label="Motif (facultatif)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Budget, timing, concurrent…" aria-label="Motif de perte" autoFocus />
        </Field>
      )}
      {activeProject && (
        <fieldset className="space-y-1 rounded-lg border border-line p-2" data-decide="project">
          <legend className="px-1 text-xs font-semibold text-muted">Projet « {activeProject.name} »{activeProject.published ? " (publié sur le portail)" : ""}</legend>
          {radio("projet", "continue", project, setProject, "Continue")}
          {radio("projet", "en_attente", project, setProject, "Passe en attente")}
          {radio("projet", "archive", project, setProject, "Est archivé")}
        </fieldset>
      )}
      {activeMission && (
        <fieldset className="space-y-1 rounded-lg border border-line p-2" data-decide="revenue">
          <legend className="px-1 text-xs font-semibold text-muted">Revenu « {activeMission.label} »{activeMission.kind === "recurrent" ? " (mensuel)" : " (ponctuel)"}</legend>
          {radio("revenu", "continue", revenue, setRevenue, activeMission.kind === "recurrent" ? "Les échéances futures continuent" : "La prévision reste")}
          <span className="flex flex-wrap items-center gap-1.5">
            {radio("revenu", "stop", revenue, setRevenue, activeMission.kind === "recurrent" ? "Les échéances s'arrêtent le" : "La prévision est retirée")}
            {activeMission.kind === "recurrent" && <Input type="date" value={stopOn} onChange={(e) => setStopOn(e.target.value)} className="h-8 w-auto" aria-label="Date d'arrêt" disabled={revenue !== "stop"} />}
          </span>
          <p className="text-xs text-muted">Les factures et règlements déjà enregistrés gardent leur historique.</p>
        </fieldset>
      )}
      {people.length > 0 && (
        <fieldset className="space-y-1 rounded-lg border border-line p-2" data-decide="portal">
          <legend className="px-1 text-xs font-semibold text-muted">Accès client au portail ({people.map((p) => p.name).join(", ")})</legend>
          {radio("portail", "keep", portal, setPortal, "Maintenus")}
          {radio("portail", "revoke", portal, setPortal, "Révoqués")}
          {people.some((p) => p.other_projects > 0) && <p className="text-xs text-muted">Une personne qui suit un autre projet actif garde son accès.</p>}
        </fieldset>
      )}
      {!activeProject && !activeMission && !people.length && status === "open" && <p className="text-muted">La fiche retrouve sa dernière étape dans Pipelines.</p>}
      {error && <p className="rounded-lg bg-danger/5 px-2 py-1.5 text-xs text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="submit" size="sm" variant={status === "lost" ? "danger" : "secondary"} disabled={busy}>
          {status === "open" ? <><RotateCcw size={13} /> Rouvrir</> : <><X size={13} /> Marquer perdu</>}
        </Button>
      </div>
    </form>
  );
}

/** Client qui revient : la vente actuelle reste dans Ventes, une nouvelle opportunité s'ouvre sur la même fiche. */
function NewOpportunityForm({ target, onDone, onCancel }: { target: ClosingTarget; onDone: () => void; onCancel: () => void }) {
  const { pipelines } = useCrm();
  const sync = useSync();
  const [stage, setStage] = useState(pipelines[0]?.stages[0]?.id ?? "");
  const [key] = useState(() => `nouvelle-opportunite-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const r = await attempt(() => newOpportunityAction(target.id, stage, key));
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    sync(["company", target.id], ["company-timeline", target.id], ["companies"], ["pipeline-cards"], ["sales"]);
    toast.success(`${target.name} : nouvelle opportunité ouverte ; la vente précédente reste dans Ventes`);
    onDone();
  }
  return (
    <div className="space-y-2.5 text-sm" data-new-opportunity>
      <p className="font-semibold">Nouvelle opportunité</p>
      <p className="text-muted">Le client revient pour une nouvelle mission : même fiche, mêmes contacts. La vente actuelle, son projet et son revenu restent consultables dans Ventes.</p>
      <Select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Étape de départ">
        {pipelines.map((p) => <optgroup key={p.id} label={p.name}>{p.stages.map((st) => <option key={st.id} value={st.id}>{p.name} › {st.name}</option>)}</optgroup>)}
      </Select>
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="button" size="sm" disabled={busy || !stage} onClick={() => void submit()}><Plus size={13} /> Ouvrir</Button>
      </div>
    </div>
  );
}

/**
 * Commandes de clôture dans l'en-tête de la fiche : « Gagné » / « Perdu » sur une opportunité ouverte ;
 * une fois clôturée, badge daté (détail, réouverture, nouvelle opportunité) et accès à l'endroit où reprendre.
 */
export function DealClosingControls({ target }: { target: ClosingTarget }) {
  const [form, setForm] = useState<"lost" | "menu" | "reopen" | "new" | null>(null);
  const [win, setWin] = useState<null | "win" | "complete">(null);
  const sale = useSale(target.id);
  const ref = useDismiss(form !== null, () => setForm(null));
  const winDialog = <WinSaleDialog company={{ id: target.id, name: target.name }} open={win !== null} complete={win === "complete"} onClose={() => setWin(null)} />;
  const close = () => setForm(null);

  if (target.deal_status === "open") {
    return (
      <div ref={ref} className="flex items-center gap-1" data-deal-actions>
        <Button size="sm" onClick={() => setWin("win")} className="h-8 border-success/30 text-success hover:bg-success/5"><Trophy size={13} /> Gagné</Button>
        <Anchored open={form === "lost"} align="right" panel={<TransitionForm target={target} status="lost" onDone={close} onCancel={close} />}>
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
      <Anchored open={form !== null} panel={
        form === "reopen" ? <TransitionForm target={target} status="open" onDone={close} onCancel={close} />
        : form === "new" ? <NewOpportunityForm target={target} onDone={close} onCancel={close} />
        : (
          <div className="space-y-2 text-sm">
            <p>{won ? <>Gagné{date ? ` le ${date}` : ""}{s && amountLine(s) ? ` · ${amountLine(s)}` : ""}</> : <>Perdu{date ? ` le ${date}` : ""}{target.lost_reason ? ` : ${target.lost_reason}` : ""}</>}</p>
            {won && s?.signed_on && <p className="text-xs text-muted">Signé le {closedOnLabel(s.signed_on)}</p>}
            {won && s?.mission_status === "termine" && <p className="text-xs text-warning">Le revenu de cette vente est arrêté.</p>}
            {won && s?.project_status === "archive" && <p className="text-xs text-warning">Le projet de cette vente est archivé.</p>}
            <div className="flex flex-wrap gap-1.5">
              <Link href={won ? "/ventes" : "/ventes?vue=perdues"} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-semibold hover:bg-surface">Voir dans Ventes <ArrowRight size={12} /></Link>
              <Button size="sm" onClick={() => setForm("reopen")}><RotateCcw size={13} /> Rouvrir l&apos;opportunité</Button>
              {won && <Button size="sm" variant="ghost" onClick={() => setForm("new")}><Plus size={13} /> Nouvelle opportunité</Button>}
            </div>
            <p className="text-xs text-muted">« Rouvrir » corrige une clôture ; « Nouvelle opportunité » sert quand le client revient pour une nouvelle mission.</p>
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

/** Menu compact d'une carte du Kanban : mêmes clôtures que la fiche, mêmes décisions. */
export function CardClosingMenu({ target, onChanged }: { target: ClosingTarget; onChanged: (status: DealStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<"lost" | null>(null);
  const [win, setWin] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface";
  return (
    <div ref={ref} className="relative" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(!open)} aria-label={`Clôturer ${target.name}`} aria-expanded={open} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="fade-in absolute top-full right-0 z-30 mt-1 w-52 rounded-xl border border-line bg-white p-1 shadow-lg" role="menu">
          <button type="button" role="menuitem" className={cn(item, "text-success")} onClick={() => { setOpen(false); setWin(true); }}><Trophy size={14} /> Gagné</button>
          <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => { setOpen(false); setForm("lost"); }}><X size={14} /> Perdu</button>
        </div>
      )}
      <Modal open={form !== null} onClose={() => setForm(null)} title={target.name}>
        {form === "lost" && <TransitionForm target={target} status="lost" onDone={() => { setForm(null); onChanged("lost"); }} onCancel={() => setForm(null)} />}
      </Modal>
      <WinSaleDialog company={{ id: target.id, name: target.name }} open={win} onClose={() => setWin(false)} onDone={() => onChanged("won")} />
    </div>
  );
}

/** L'issue de l'opportunité, à côté de l'étape : même logique que le Kanban et Ventes. */
export function RecordDealClosing({ ctx }: { ctx: RecordCtx }) {
  const c = ctx.detail.company;
  return <DealClosingControls target={{ id: c.id, name: c.name, deal_status: c.deal_status, amount: c.amount, deal_closed_at: c.deal_closed_at, lost_reason: c.lost_reason }} />;
}
