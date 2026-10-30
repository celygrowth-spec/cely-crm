"use client";

// Préparation : vérifier personnes ciblées, coordonnées, variables, personnalisations et
// conflits avant d'activer. Activer = rendre les actions disponibles ; rien n'est envoyé.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Ban, Check, Mail, Phone, Plus, Zap } from "lucide-react";
import { updateParticipantsAction } from "@/app/prospection-actions";
import { useActivation } from "@/components/prospection/activate-dialog";
import { LinkedinGlyph, StepIcon } from "@/components/prospection/bits";
import { EnrollModal } from "@/components/prospection/enroll-modal";
import { ParticipantPanel } from "@/components/prospection/participant-panel";
import { Badge, Button, EmptyState, Select, cn } from "@/components/ui";
import { personName } from "@/lib/format";
import type { CampaignWorkspace } from "@/lib/prospection/service";
import { STEP_META, variableLabel } from "@/lib/prospection/steps";
import { readiness, stepsOf, targetPerson } from "@/lib/prospection/workspace";

export function Preparation({ ws }: { ws: CampaignWorkspace }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const { activate, busy, dialog } = useActivation(ws.campaign.id, () => setSelected(new Set()));
  const steps = stepsOf(ws, ws.campaign.current_version);
  const needs = new Set(steps.map((s) => STEP_META[s.step_type].needs).filter(Boolean));

  const rows = useMemo(() => {
    const conflictCount = new Map<string, number>();
    ws.conflicts.forEach((c) => conflictCount.set(c.participant_id, (conflictCount.get(c.participant_id) ?? 0) + 1));
    return ws.participants
      .filter((p) => p.status === "a_preparer")
      .map((p) => {
        const person = targetPerson(p, ws.people);
        const st = stepsOf(ws, p.sequence_version);
        return {
          p,
          person,
          steps: st,
          ready: readiness(p, st, ws.people, ws.drafts, conflictCount.get(p.id) ?? 0),
          drafts: ws.drafts.filter((d) => d.participant_id === p.id).length,
          companyPeople: ws.people.filter((x) => x.company_id === p.company_id),
        };
      });
  }, [ws]);
  const readyIds = rows.filter((r) => r.ready.ready && !r.ready.conflicts).map((r) => r.p.id);

  async function setPerson(id: string, personId: string) {
    const r = await updateParticipantsAction([id], "set_person", { reason: personId || null });
    if (!r.ok) return toast.error(r.error);
    if (r.data.errors.length) return toast.error(r.data.errors[0]);
    router.refresh();
  }

  if (!steps.length) {
    return <EmptyState title="Séquence vide" description="Construisez d'abord la séquence de cette campagne." action={<Button onClick={() => router.push(`/prospection/campagnes/${ws.campaign.id}/sequence`)}>Ouvrir la séquence</Button>} />;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted">
          <strong className="text-ink">{rows.length}</strong> à préparer · <strong className="text-success">{readyIds.length}</strong> prêt(s) ·{" "}
          {rows.length - readyIds.length} à vérifier
        </p>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => setEnrollOpen(true)}><Plus size={13} /> Ajouter des prospects</Button>
          <Button size="sm" disabled={!readyIds.length} onClick={() => setSelected(new Set(readyIds))}>Sélectionner les prêts ({readyIds.length})</Button>
          <Button size="sm" variant="primary" disabled={!selected.size || busy} onClick={() => activate([...selected])}>
            <Zap size={13} /> Activer la sélection ({selected.size})
          </Button>
        </div>
      </div>
      <p className="mb-3 rounded-lg bg-surface px-3 py-2 text-xs text-muted">
        Activer rend les actions disponibles dans « Aujourd&apos;hui » et calcule les échéances à partir d&apos;aujourd&apos;hui. <strong className="text-ink">Aucun message n&apos;est envoyé.</strong>{" "}
        Une personne sans email ne bloque pas une séquence exclusivement LinkedIn : seules les coordonnées utilisées par cette séquence sont vérifiées.
      </p>

      {!rows.length ? (
        <EmptyState title="Rien à préparer" description="Ajoutez des prospects : ils apparaîtront ici avant activation." action={<Button variant="primary" onClick={() => setEnrollOpen(true)}><Plus size={14} /> Ajouter des prospects</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-line bg-surface text-left font-label text-xs text-muted">
              <tr>
                <th className="w-9 px-2 py-2">
                  <input type="checkbox" aria-label="Tout sélectionner" checked={selected.size === rows.length && rows.length > 0} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.p.id)) : new Set())} />
                </th>
                <th className="px-2 py-2">Entreprise</th>
                <th className="px-2 py-2">Personne ciblée</th>
                <th className="px-2 py-2">Coordonnées utiles</th>
                <th className="px-2 py-2">Variables</th>
                <th className="px-2 py-2">Personnalisation</th>
                <th className="px-2 py-2">Sollicitation</th>
                <th className="px-2 py-2">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.p.id} className={cn("align-top hover:bg-violet-soft/30", selected.has(r.p.id) && "bg-violet-soft/50")}>
                  <td className="px-2 py-2">
                    <input type="checkbox" aria-label={`Sélectionner ${r.p.company.name}`} checked={selected.has(r.p.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.p.id)) n.delete(r.p.id); else n.add(r.p.id); return n; })} />
                  </td>
                  <td className="px-2 py-2">
                    <button className="text-left font-semibold hover:text-violet-strong" onClick={() => setPanel(r.p.id)}>{r.p.company.name}</button>
                    {r.p.company.do_not_contact && <Badge tone="danger" className="ml-1"><Ban size={10} /> Ne plus contacter</Badge>}
                  </td>
                  <td className="px-2 py-2">
                    <Select value={r.p.person_id ?? ""} onChange={(e) => setPerson(r.p.id, e.target.value)} className={cn("h-8 w-48 text-xs", !r.person && "border-warning")} aria-label="Personne ciblée">
                      <option value="">— Choisir —</option>
                      {r.companyPeople.map((x) => <option key={x.id} value={x.id}>{personName(x)}{x.title ? ` · ${x.title}` : ""}</option>)}
                    </Select>
                    {!r.companyPeople.length && <p className="mt-1 text-[11px] text-danger">Aucune personne sur la fiche</p>}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1.5">
                      {needs.has("linkedin") && <ContactDot ok={!!r.person?.linkedin_url} label="LinkedIn" icon={<LinkedinGlyph size={11} />} />}
                      {needs.has("email") && <ContactDot ok={!!r.person?.email} label="Email" icon={<Mail size={11} />} />}
                      {needs.has("phone") && <ContactDot ok={!!r.person?.phone} label="Téléphone" icon={<Phone size={11} />} />}
                      {!needs.size && <span className="text-xs text-muted">Aucune</span>}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {r.ready.missingVariables.length ? (
                      <div className="space-y-0.5 text-amber-800">
                        {r.ready.missingVariables.map((m) => {
                          const st = r.steps.find((s) => s.position === m.step);
                          return (
                            <p key={m.step} className="flex items-center gap-1">
                              {st && <StepIcon type={st.step_type} size={9} />} Étape {m.step} : {m.variables.map(variableLabel).join(", ")}
                            </p>
                          );
                        })}
                        <button className="text-violet-strong underline" onClick={() => setPanel(r.p.id)}>Corriger dans le message</button>
                      </div>
                    ) : <span className="text-success">Complètes</span>}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    <button className="text-violet-strong hover:underline" onClick={() => setPanel(r.p.id)}>
                      {r.drafts ? `${r.drafts} message(s) personnalisé(s)` : "Aperçu et personnalisation"}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {r.ready.conflicts ? (
                      <span className="flex items-center gap-1 text-amber-800"><AlertTriangle size={12} /> {ws.conflicts.filter((c) => c.participant_id === r.p.id).map((c) => c.other_campaign_name).join(", ")}</span>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-2">
                    {r.ready.ready ? (
                      r.ready.conflicts ? <Badge tone="warning">À confirmer</Badge> : <Badge tone="success"><Check size={10} /> Prêt</Badge>
                    ) : <Badge tone="warning">À compléter</Badge>}
                    {r.ready.ready && r.ready.missingContacts.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted">Coordonnée manquante pour une étape ultérieure : {r.ready.missingContacts.map((m) => `étape ${m.step}`).join(", ")}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {panel && (() => {
        const r = rows.find((x) => x.p.id === panel) ?? null;
        const p = r?.p ?? ws.participants.find((x) => x.id === panel);
        if (!p) return null;
        return (
          <ParticipantPanel p={p} steps={stepsOf(ws, p.sequence_version)} people={ws.people} drafts={ws.drafts} conflicts={ws.conflicts.filter((c) => c.participant_id === p.id)} onClose={() => setPanel(null)} />
        );
      })()}
      <EnrollModal campaignId={ws.campaign.id} open={enrollOpen} onClose={() => setEnrollOpen(false)} />
      {dialog}
    </div>
  );
}

function ContactDot({ ok, label, icon }: { ok: boolean; label: string; icon: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]", ok ? "border-success/30 bg-success/5 text-success" : "border-danger/30 bg-danger/5 text-danger")} title={`${label} ${ok ? "disponible" : "manquant"}`}>
      {icon}{ok ? <Check size={10} /> : "manquant"}
    </span>
  );
}
