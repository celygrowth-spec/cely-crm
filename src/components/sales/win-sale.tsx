"use client";

// « Marquer comme gagné » : un seul formulaire court, partagé par la fiche, le Kanban et Ventes.
// Une seule transaction (fiche Gagné, vente suivie, revenu prévu, projet) ; la préparation du projet suit en
// arrière-plan. La clé reste la même pendant toute la fenêtre : un double clic ou une relance après erreur
// retrouvent le même projet et le même revenu.
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Link2 } from "lucide-react";
import { confirmSaleAction, saleContextAction } from "@/app/sales-actions";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { centsToInput, eur, parseEuroInput, toCents } from "@/lib/finance/money";
import { todayISO } from "@/lib/format";
import type { SaleRow } from "@/lib/sales/rules";
import type { ConfirmInput, SaleContext } from "@/lib/sales/service";
import { DuePreview } from "@/components/finance/revenue-forms";
import { Button, Field, Input, Modal, Select, Skeleton, cn } from "@/components/ui";

export const useSales = (initial?: SaleRow[]) =>
  useQuery({ queryKey: ["sales"], queryFn: ({ signal }) => apiGet<SaleRow[]>("/api/ventes", signal), initialData: initial, staleTime: 15_000 });
export const useSale = (companyId: string) =>
  useQuery({ queryKey: ["sales", companyId], queryFn: ({ signal }) => apiGet<SaleRow | null>(`/api/ventes?fiche=${companyId}`, signal) });

/** Tout ce qui lit une vente se relit : fiche, activité, Kanban, Ventes, projets, Finance. */
export function useSaleSync() {
  const sync = useSync();
  return (companyId: string) => sync(["company", companyId], ["company-timeline", companyId], ["companies"], ["pipeline-cards"], ["sales"], ["company-projects", companyId], ["finance"]);
}

type Mode = "mensuel" | "ponctuel" | "plus_tard";

/**
 * `complete` : la fiche est déjà gagnée (ancien dossier, ou revenu « à renseigner plus tard ») : la clôture
 * n'est pas modifiée, on complète seulement ce qui manque.
 */
export function WinSaleDialog({ company, open, onClose, complete = false, onDone }: {
  company: { id: string; name: string }; open: boolean; onClose: () => void; complete?: boolean; onDone?: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={complete ? `Compléter la vente · ${company.name}` : "Marquer comme gagné"}>
      {open && <WinBody company={company} complete={complete} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function WinBody({ company, complete, onClose, onDone }: { company: { id: string; name: string }; complete: boolean; onClose: () => void; onDone?: () => void }) {
  const ctx = useQuery({
    queryKey: ["sale-context", company.id],
    queryFn: async () => {
      const r = await saleContextAction(company.id);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    staleTime: 0,
  });
  if (ctx.isLoading) return <div className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (ctx.isError || !ctx.data) return <p className="text-sm text-danger">{ctx.error?.message ?? "Chargement impossible."} <button className="underline" onClick={() => ctx.refetch()}>Réessayer</button></p>;
  return <WinForm company={company} complete={complete} ctx={ctx.data} onClose={onClose} onDone={onDone} />;
}

function WinForm({ company, complete, ctx, onClose, onDone }: { company: { id: string; name: string }; complete: boolean; ctx: SaleContext; onClose: () => void; onDone?: () => void }) {
  const router = useRouter();
  const saleSync = useSaleSync();
  const today = todayISO();
  const linked = ctx.sale?.mission_id ? ctx.missions.find((m) => m.id === ctx.sale!.mission_id) ?? null : null;
  const free = ctx.missions.filter((m) => m.id !== ctx.sale?.mission_id);
  const dealCents = toCents(ctx.company.amount);
  // préremplissage fiable : montant de la fiche (ponctuel), date prévue de la fiche ; rien n'est deviné au-delà
  const [mode, setMode] = useState<Mode>(linked ? (linked.kind === "recurrent" ? "mensuel" : "ponctuel") : dealCents ? "ponctuel" : "plus_tard");
  const [closedOn, setClosedOn] = useState(today);
  const [signedOn, setSignedOn] = useState(ctx.sale?.signed_on ?? "");
  const [docsReady, setDocsReady] = useState(ctx.sale?.documents_ready ?? false);
  const [amount, setAmount] = useState(centsToInput(dealCents));
  const [date, setDate] = useState(ctx.company.expected_close_date && ctx.company.expected_close_date >= today ? ctx.company.expected_close_date : today);
  const [end, setEnd] = useState("");
  const [linkMission, setLinkMission] = useState(free.length === 1 && !linked ? free[0].id : "");
  const [linkInvoice, setLinkInvoice] = useState("");
  const [linkProject, setLinkProject] = useState(ctx.sale?.project_id ?? (ctx.projects.length === 1 ? ctx.projects[0].id : ""));
  const [projectName, setProjectName] = useState(`Mission ${company.name}`);
  // projet de la vente supprimé : jamais recréé sans votre accord (Q05)
  const projectRemoved = !!ctx.sale?.project_removed_at && !ctx.sale?.project_id;
  const [recreate, setRecreate] = useState(false);
  const [key] = useState(() => `sale-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseEuroInput(amount);
  const usesExisting = !!linkMission || !!linked;
  const contractFile = ctx.files.some((f) => f.category === "Contrat");
  const invoices = ctx.invoices.filter((i) => !i.mission_id || i.mission_id === (linkMission || linked?.id));

  async function submit() {
    setError(null);
    let revenue: ConfirmInput["revenue"] = { mode: "plus_tard" };
    if (!usesExisting && mode !== "plus_tard") {
      if (cents == null || Number.isNaN(cents) || cents <= 0) return setError("Indiquez un montant valide, ou choisissez « Renseigner plus tard ».");
      if (!date) return setError(mode === "mensuel" ? "Indiquez la date de début." : "Indiquez la date d'encaissement prévue.");
      if (mode === "mensuel" && end && end < date) return setError("La date de fin précède la date de début.");
      revenue = mode === "mensuel" ? { mode, amount_cents: cents, date, end_date: end || null } : { mode, amount_cents: cents, date };
    }
    if (!complete && closedOn > today) return setError("La date de clôture ne peut pas être dans le futur.");
    if (signedOn && signedOn > today) return setError("La date de signature ne peut pas être dans le futur.");
    setBusy(true);
    const r = await attempt(() => confirmSaleAction(company.id, {
      closed_on: closedOn, signed_on: signedOn || null, documents_ready: docsReady, revenue,
      link_mission_id: linkMission || null, link_invoice_id: linkInvoice || null,
      link_project_id: ctx.sale?.project_id ? null : linkProject || null, project_name: projectName,
      ...(projectRemoved ? { create_project: recreate } : {}),
    }, key));
    setBusy(false);
    // la même clé est gardée : « Réessayer » retrouve ce qui a déjà été enregistré, sans doublon
    if (!r.ok) return setError(r.error);
    saleSync(company.id);
    onDone?.();
    onClose();
    toast.success(complete ? `${company.name} : vente complétée` : `${company.name} : vente gagnée`, {
      description: r.data.created.project ? "Projet créé, préparation en cours." : r.data.project_id ? "Projet lié." : undefined,
      action: { label: "Voir dans Ventes", onClick: () => router.push("/ventes") },
      duration: 8000,
    });
  }

  const seg = (m: Mode, label: string) => (
    <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} disabled={usesExisting}
      className={cn("flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40", mode === m ? "bg-ink text-white" : "text-muted hover:text-ink")}>
      {label}
    </button>
  );

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-win-sale>
      <p className="text-sm">Client : <strong>{company.name}</strong></p>
      <div className="grid grid-cols-2 gap-2">
        {!complete && (
          <Field label="Date de clôture">
            <Input type="date" value={closedOn} max={today} onChange={(e) => setClosedOn(e.target.value)} aria-label="Date de clôture" />
          </Field>
        )}
        <Field label="Signée le (si connu)">
          <Input type="date" value={signedOn} max={today} onChange={(e) => setSignedOn(e.target.value)} aria-label="Date de signature" />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-violet-600" checked={docsReady} onChange={(e) => setDocsReady(e.target.checked)} />
        <span>Devis ou contrat déjà signé <span className="text-muted">{contractFile ? "(un contrat est sur la fiche)" : "— sinon le dossier commence en « Devis / Contrat »"}</span></span>
      </label>

      <fieldset className="space-y-2 rounded-xl border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-muted">Revenu</legend>
        {linked ? (
          <p className="flex items-center gap-1.5 text-sm"><Link2 size={14} className="text-muted" /> Déjà lié : <strong>{linked.label}</strong> · {eur(toCents(linked.amount), { round: true })}{linked.kind === "recurrent" ? " / mois" : ""}</p>
        ) : (
          <>
            {free.length > 0 && (
              <Field label="Un revenu existe déjà pour ce client">
                <Select value={linkMission} onChange={(e) => setLinkMission(e.target.value)} aria-label="Lier un revenu existant">
                  <option value="">Ne pas lier : renseigner ci-dessous</option>
                  {free.map((m) => <option key={m.id} value={m.id}>Lier « {m.label} » · {eur(toCents(m.amount), { round: true })}{m.kind === "recurrent" ? " / mois" : ""}</option>)}
                </Select>
              </Field>
            )}
            {!linkMission && (
              <>
                <div role="radiogroup" aria-label="Type de revenu" className="flex gap-1 rounded-lg border border-line p-0.5">
                  {seg("mensuel", "Mensuel")}{seg("ponctuel", "Ponctuel")}{seg("plus_tard", "Renseigner plus tard")}
                </div>
                {mode === "mensuel" && (
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Par mois (HT)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1 000" aria-label="Montant par mois" autoFocus /></Field>
                    <Field label="Début"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date de début" /></Field>
                    <Field label="Fin (facultatif)"><Input type="date" value={end} min={date} onChange={(e) => setEnd(e.target.value)} aria-label="Date de fin" /></Field>
                  </div>
                )}
                {mode === "mensuel" && cents != null && !Number.isNaN(cents) && date && <DuePreview first={date} end={end || null} amount={cents} />}
                {mode === "ponctuel" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Montant (HT)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2 500" aria-label="Montant" autoFocus /></Field>
                    <Field label="Encaissement prévu"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date d'encaissement prévue" /></Field>
                  </div>
                )}
                {mode === "plus_tard" && <p className="text-xs text-muted">La vente est validée ; la carte affichera « Facturation à renseigner ».</p>}
              </>
            )}
          </>
        )}
        {invoices.length > 0 && (
          <Field label="Facture déjà enregistrée (facultatif)">
            <Select value={linkInvoice} onChange={(e) => setLinkInvoice(e.target.value)} aria-label="Lier une facture existante">
              <option value="">Aucune</option>
              {invoices.map((i) => <option key={i.id} value={i.id}>{i.reference ?? "Facture"} du {i.issue_date} · {eur(toCents(i.amount_ttc), { round: true })} TTC</option>)}
            </Select>
          </Field>
        )}
      </fieldset>

      {projectRemoved && !linkProject && (
        <label className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm" data-project-removed>
          <input type="checkbox" className="mt-0.5 accent-violet-600" checked={recreate} onChange={(e) => setRecreate(e.target.checked)} />
          <span>Le projet de cette vente a été supprimé. Le recréer ?</span>
        </label>
      )}
      {!ctx.sale?.project_id && (!projectRemoved || recreate || ctx.projects.length > 0) && (
        ctx.projects.length > 0 ? (
          <Field label="Projet">
            <Select value={linkProject} onChange={(e) => setLinkProject(e.target.value)} aria-label="Projet lié">
              {ctx.projects.map((p) => <option key={p.id} value={p.id}>Lier « {p.name} »</option>)}
              <option value="">Créer « {projectName} »</option>
            </Select>
          </Field>
        ) : (
          <Field label="Projet créé pour l'onboarding">
            <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={160} aria-label="Nom du projet" />
          </Field>
        )
      )}

      {error && <p className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{error} <span className="text-muted">Réessayer ne crée rien en double.</span></p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={busy}><Check size={14} /> {busy ? "Enregistrement…" : complete ? "Enregistrer" : error ? "Réessayer" : "Confirmer la vente"}</Button>
      </div>
    </form>
  );
}
