"use client";

// Menu « Actions » de la fiche : faire avancer le prospect sans quitter la fiche.
//  * « Ajouter à une pipeline » : même fiche placée (ou déplacée) dans l'étape choisie ;
//  * « Passer en client » : raccourci de Prospection → Pipeline → « Marquer comme gagné », même formulaire,
//    même résultat (vente, revenu, projet et onboarding).
// Les deux passent par une seule opération en base (company_add_to_pipeline, company_make_client). Les relances
// de campagne en cours ne sont jamais arrêtées ou conservées sans votre choix. Une prochaine action est proposée
// pour que la fiche et Aujourd'hui montrent toujours la suite.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Check } from "lucide-react";
import { addToPipelineAction, makeClientAction } from "@/app/fiche-actions";
import { attempt } from "@/lib/client/query";
import { addDaysISO, personName, relativeDay, todayISO } from "@/lib/format";
import type { FollowupsChoice, NextTask } from "@/lib/crm/advance";
import type { CompanyDetail } from "@/lib/crm/types";
import { useCrm } from "./app-shell";
import type { RecordCtx } from "./company-record";
import { WinSaleDialog, useSaleSync } from "./sales/win-sale";
import { Button, Field, Input, Modal, Select } from "./ui";

const ACTIVE = ["a_contacter", "en_cours", "a_repondu"];

function activeFollowups(detail: CompanyDetail) {
  return detail.participants.filter((p) => ACTIVE.includes(p.status));
}

/** Relances en cours : le choix vous revient, sans valeur par défaut. */
function FollowupsDecision({ detail, value, onChange }: { detail: CompanyDetail; value: FollowupsChoice | null; onChange: (v: FollowupsChoice) => void }) {
  const active = activeFollowups(detail);
  if (!active.length) return null;
  const names = [...new Set(active.map((p) => p.campaign.name))].join(", ");
  return (
    <fieldset className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm" data-followups-decision>
      <legend className="px-1 text-xs font-semibold text-ink">Prospection en cours</legend>
      <p>Cette fiche a {active.length} relance{active.length > 1 ? "s" : ""} en cours ({names}). Que deviennent-elles ?</p>
      <label className="flex items-center gap-1.5"><input type="radio" name="relances" className="accent-violet-600" checked={value === "stop"} onChange={() => onChange("stop")} /> Les arrêter (l&apos;historique reste consultable)</label>
      <label className="flex items-center gap-1.5"><input type="radio" name="relances" className="accent-violet-600" checked={value === "keep"} onChange={() => onChange("keep")} /> Les garder : elles restent dans Aujourd&apos;hui</label>
    </fieldset>
  );
}

/** La prochaine chose à faire : tâche de la fiche, visible dans l'Aperçu et dans Aujourd'hui. */
function useNextStep(detail: CompanyDetail, title: string, inDays: number) {
  const open = detail.tasks.filter((t) => !t.done_at).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const primary = detail.people.find((p) => p.is_primary) ?? detail.people[0] ?? null;
  const [on, setOn] = useState(open.length === 0);
  const [text, setText] = useState(title);
  const [due, setDue] = useState(addDaysISO(todayISO(), inDays));
  const value: NextTask | null = on ? { title: text.trim(), due_date: due, person_id: primary?.id ?? null } : null;
  const check = () => (on && !text.trim() ? "Indiquez la prochaine action, ou décochez-la." : on && !due ? "Indiquez la date de la prochaine action." : null);
  const fields = (
    <fieldset className="space-y-2 rounded-xl border border-line p-3 text-sm" data-next-step>
      <legend className="px-1 text-xs font-semibold text-muted">Prochaine action</legend>
      {open[0] && <p className="text-xs text-muted">Déjà prévue : {open[0].title} · {relativeDay(open[0].due_date)}</p>}
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-violet-600" checked={on} onChange={(e) => setOn(e.target.checked)} />
        {open[0] ? "Ajouter une autre action" : "Créer la prochaine action"}
      </label>
      {on && (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} aria-label="Prochaine action" />
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Échéance de la prochaine action" className="sm:w-40" />
        </div>
      )}
    </fieldset>
  );
  return { value, check, fields, primary };
}

function StageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { pipelines } = useCrm();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Pipeline et étape">
      {pipelines.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

function NoPipeline({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  return (
    <div className="space-y-3 text-sm">
      <p>Aucune pipeline n&apos;existe encore. Créez-en une (avec ses étapes) dans Pipelines, puis revenez sur la fiche.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Fermer</Button>
        <Button variant="primary" onClick={() => router.push("/pipelines")}>Ouvrir Pipelines <ArrowRight size={14} /></Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ajouter à une pipeline
// ---------------------------------------------------------------------------

export function AddToPipelineDialog({ ctx, open, onClose }: { ctx: RecordCtx; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={ctx.detail.company.pipeline_id ? "Déplacer dans une pipeline" : "Ajouter à une pipeline"}>
      {open && <AddToPipelineForm ctx={ctx} onClose={onClose} />}
    </Modal>
  );
}

function AddToPipelineForm({ ctx, onClose }: { ctx: RecordCtx; onClose: () => void }) {
  const { pipelines } = useCrm();
  const router = useRouter();
  const c = ctx.detail.company;
  const [stage, setStage] = useState(c.stage_id ?? pipelines[0]?.stages[0]?.id ?? "");
  const [followups, setFollowups] = useState<FollowupsChoice | null>(null);
  const contact = (ctx.detail.people.find((p) => p.is_primary) ?? ctx.detail.people[0]);
  const next = useNextStep(ctx.detail, `Relancer ${contact ? personName(contact) : c.name}`, 3);
  const [key] = useState(() => `fiche-pipeline-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pipelines.some((p) => p.stages.length)) return <NoPipeline onClose={onClose} />;
  const closed = c.deal_status !== "open";
  const target = pipelines.find((p) => p.stages.some((s) => s.id === stage));
  const targetStage = target?.stages.find((s) => s.id === stage);

  async function submit() {
    setError(null);
    if (activeFollowups(ctx.detail).length && !followups) return setError("Choisissez ce que deviennent les relances en cours.");
    const err = next.check();
    if (err) return setError(err);
    setBusy(true);
    const r = await attempt(() => addToPipelineAction(c.id, { stageId: stage, followups, next: next.value }, key));
    setBusy(false);
    if (!r.ok) return setError(r.error); // rien n'a été enregistré : la saisie reste, « Réessayer » rejoue la même demande
    await ctx.reload();
    onClose();
    const where = `${target?.name ?? ""} › ${targetStage?.name ?? ""}`;
    const extra = [r.data.stopped_followups ? `${r.data.stopped_followups} relance(s) arrêtée(s)` : null, r.data.kept_followups ? `${r.data.kept_followups} relance(s) conservée(s)` : null,
      r.data.task_id ? "prochaine action ajoutée" : null].filter(Boolean).join(" · ");
    toast.success(r.data.status === "unchanged" ? `${c.name} est déjà dans ${where}` : `${c.name} : ${where}`, {
      description: extra || undefined,
      action: target ? { label: "Voir dans Pipelines", onClick: () => router.push(`/pipelines/${target.id}`) } : undefined,
      duration: 8000,
    });
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-add-to-pipeline>
      <p className="text-sm">Fiche : <strong>{c.name}</strong></p>
      {c.pipeline && <p className="text-sm" data-current-stage>Position actuelle : <strong>{c.pipeline.name} › {c.stage?.name ?? "—"}</strong></p>}
      {closed ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
          Opportunité {c.deal_status === "won" ? "gagnée : la fiche est cliente" : "perdue"}. Elle reste clôturée : utilisez le badge « {c.deal_status === "won" ? "Gagné" : "Perdu"} » en haut de la fiche
          pour la rouvrir{c.deal_status === "won" ? " ou ouvrir une nouvelle opportunité" : ""}.
        </p>
      ) : (
        <>
          <Field label={c.pipeline_id ? "Nouvelle étape" : "Pipeline et étape"}>
            <StageSelect value={stage} onChange={setStage} />
          </Field>
          <FollowupsDecision detail={ctx.detail} value={followups} onChange={setFollowups} />
          {next.fields}
        </>
      )}
      {error && <p className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>{closed ? "Fermer" : "Annuler"}</Button>
        {!closed && <Button type="submit" variant="primary" disabled={busy || !stage}><Check size={14} /> {busy ? "Enregistrement…" : error ? "Réessayer" : c.pipeline_id ? "Déplacer" : "Ajouter"}</Button>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Passer en client
// ---------------------------------------------------------------------------

export function MakeClientDialog({ ctx, open, onClose }: { ctx: RecordCtx; open: boolean; onClose: () => void }) {
  const { pipelines } = useCrm();
  const c = ctx.detail.company;
  if (!open) return null;
  if (!c.pipeline_id && !pipelines.some((p) => p.stages.length)) {
    return <Modal open onClose={onClose} title="Passer en client"><NoPipeline onClose={onClose} /></Modal>;
  }
  return <MakeClient ctx={ctx} onClose={onClose} />;
}

function MakeClient({ ctx, onClose }: { ctx: RecordCtx; onClose: () => void }) {
  const { pipelines } = useCrm();
  const router = useRouter();
  const saleSync = useSaleSync();
  const c = ctx.detail.company;
  // la vente passe par une pipeline, comme dans le parcours normal : par défaut la dernière étape de la première
  const first = pipelines.find((p) => p.stages.length);
  const [stage, setStage] = useState(c.stage_id ?? first?.stages[first.stages.length - 1]?.id ?? "");
  const [followups, setFollowups] = useState<FollowupsChoice | null>(null);
  const next = useNextStep(ctx.detail, `Lancer l'onboarding de ${c.name}`, 0);

  const head = (
    <>
      {c.pipeline_id ? (
        <p className="text-sm">Pipeline : <strong>{c.pipeline?.name} › {c.stage?.name ?? "—"}</strong></p>
      ) : (
        <Field label="La vente passe par" hint="Comme dans le parcours normal : la fiche entre dans cette étape, puis passe Gagné.">
          <StageSelect value={stage} onChange={setStage} />
        </Field>
      )}
      {!next.primary && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs" data-no-contact>Aucun contact sur la fiche : le projet sera créé sans interlocuteur. Ajoutez-en un ensuite (Détails › Personnes) pour l&apos;onboarding.</p>}
      <FollowupsDecision detail={ctx.detail} value={followups} onChange={setFollowups} />
    </>
  );

  return (
    <WinSaleDialog
      company={{ id: c.id, name: c.name }}
      open
      onClose={onClose}
      shortcut={{
        title: "Passer en client",
        submitLabel: "Passer en client",
        head,
        foot: next.fields,
        check: () => (!c.pipeline_id && !stage ? "Choisissez la pipeline et l'étape."
          : activeFollowups(ctx.detail).length && !followups ? "Choisissez ce que deviennent les relances en cours." : next.check()),
        submit: (sale, key) => makeClientAction(c.id, { stageId: c.pipeline_id ? null : stage, followups, sale, next: next.value }, key),
        onSuccess: (data) => {
          saleSync(c.id);
          void ctx.reload();
          toast.success(`${c.name} : passée en client`, {
            description: [data.created.project ? "Projet créé, onboarding en préparation" : data.project_id ? "Projet lié" : null, "vente gagnée dans Ventes"].filter(Boolean).join(" · "),
            action: data.project_id ? { label: "Ouvrir le projet", onClick: () => router.push(`/projets/${data.project_id}`) } : { label: "Voir dans Ventes", onClick: () => router.push("/ventes") },
            duration: 8000,
          });
        },
      }}
    />
  );
}
