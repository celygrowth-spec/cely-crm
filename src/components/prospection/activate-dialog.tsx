"use client";

// Activation de participants avec gestion explicite des sollicitations simultanées.
// « Activer » rend les actions disponibles et calcule les échéances : rien n'est envoyé.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { activateAction, updateParticipantsAction } from "@/app/prospection-actions";
import { formatDate } from "@/lib/format";
import type { ActivationResult } from "@/lib/prospection/service";
import { useCrm } from "../app-shell";
import { Button, Modal } from "../ui";

type ConflictRow = Extract<ActivationResult, { status: "conflicts" }>["conflicts"][number];

export function useActivation(campaignId: string, onDone?: () => void) {
  const router = useRouter();
  const { openCompany } = useCrm();
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [busy, setBusy] = useState(false);

  async function run(ids: string[], confirm: boolean) {
    if (!ids.length) return;
    setBusy(true);
    const r = await activateAction(campaignId, ids, confirm);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.status === "conflicts") {
      setPendingIds(ids);
      setConflicts(r.data.conflicts);
      return;
    }
    setPendingIds(null);
    onDone?.();
    toast.success(`${r.data.activated} participant(s) activé(s) : leurs actions apparaissent dans « Aujourd'hui ». Aucun message n'a été envoyé.`);
    router.refresh();
  }

  async function suspendOther(c: ConflictRow) {
    const r = await updateParticipantsAction([c.other_participant_id], "stop", { reason: "Suspendu pour éviter une sollicitation simultanée" });
    if (!r.ok) return toast.error(r.error);
    toast.success(`Suivi suspendu dans « ${c.other_campaign_name} »`);
    setConflicts((cs) => cs.filter((x) => x.other_participant_id !== c.other_participant_id));
  }

  const conflictCompanies = new Set(conflicts.map((c) => c.participant_id));

  const dialog = (
    <Modal open={!!pendingIds && conflicts.length > 0} onClose={() => setPendingIds(null)} title="Sollicitation simultanée" wide>
      <p className="flex items-start gap-2 text-sm">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
        Ces entreprises sont déjà suivies dans une autre campagne active. Les activer ici risque de les contacter deux fois.
      </p>
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
        {conflicts.map((c) => (
          <li key={c.other_participant_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{c.company_name}</p>
              <p className="text-xs text-muted">
                « {c.other_campaign_name} » · {c.other_status === "a_repondu" ? "a répondu" : "en cours"} · dernière prise de contact{" "}
                {c.other_last_done_at ? formatDate(c.other_last_done_at) : "aucune"}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => openCompany(c.company_id)}>Ouvrir</Button>
            <Button size="sm" onClick={() => suspendOther(c)}>Suspendre l&apos;autre suivi</Button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button onClick={() => setPendingIds(null)}>Annuler</Button>
        {pendingIds && pendingIds.some((id) => !conflictCompanies.has(id)) && (
          <Button onClick={() => run(pendingIds.filter((id) => !conflictCompanies.has(id)), false)} disabled={busy}>Activer seulement les autres</Button>
        )}
        <Button variant="primary" onClick={() => pendingIds && run(pendingIds, true)} disabled={busy}>Je confirme : activer malgré le conflit</Button>
      </div>
    </Modal>
  );

  return { activate: (ids: string[]) => run(ids, false), busy, dialog };
}
