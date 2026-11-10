"use client";

// « Gagné » confirmé (fiche ou Kanban) : la vente et le projet client sont créés tout de suite,
// la préparation continue en arrière-plan. Un double clic retrouve le même projet.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { ONBOARDING_STATUS_LABELS, ONBOARDING_STATUS_TONES, type OnboardingStatus } from "@/lib/projects/onboarding-rules";
import { Badge, Button, Modal } from "./ui";

type Win = { closing_id: string; project_id: string; created: boolean };
type Active = { closing_id: string; project_id: string | null; status: OnboardingStatus | null } | null;

const winRequest = (companyId: string) =>
  attempt(async () => {
    const res = await fetch(`/api/fiches/${companyId}/gagne`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return (await res.json()) as { ok: true; data: Win } | { ok: false; error: string };
  });

export function useWinDeal() {
  const router = useRouter();
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  async function win(companyId: string) {
    if (busy) return false;
    setBusy(true);
    const r = await winRequest(companyId);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    const href = `/projets/${r.data.project_id}`;
    toast.success(r.data.created ? "Vente enregistrée · projet client créé, préparation en cours" : "Vente déjà enregistrée · projet retrouvé", {
      action: { label: "Ouvrir le projet", onClick: () => router.push(href) },
      duration: 8000,
    });
    sync(["company", companyId], ["companies"], ["pipeline-cards"], ["company-projects", companyId], ["deal-closing", companyId], ["company-timeline", companyId]);
    return true;
  }
  return { win, busy };
}

export function WinDealModal({ company, onClose }: { company: { id: string; name: string } | null; onClose: () => void }) {
  const { win, busy } = useWinDeal();
  return (
    <Modal open={!!company} onClose={onClose} title="Marquer la vente comme gagnée ?">
      {company && (
        <div className="space-y-4">
          <p className="text-sm">
            <strong>{company.name}</strong> passe en « Gagné ». Le projet client est créé tout de suite dans Projets et préparé à partir de la fiche,
            des appels Fireflies et du diagnostic. Rien n&apos;est partagé avec le client.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button variant="primary" disabled={busy} onClick={async () => { if (await win(company.id)) onClose(); }}>
              {busy ? "Enregistrement…" : "Confirmer la vente"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Sur une fiche gagnée : accès direct au projet de la vente, ou création s'il manque (vente antérieure). */
export function DealProjectLink({ companyId }: { companyId: string }) {
  const q = useQuery({ queryKey: ["deal-closing", companyId], queryFn: ({ signal }) => apiGet<Active>(`/api/fiches/${companyId}/gagne`, signal) });
  const { win, busy } = useWinDeal();
  if (q.isLoading) return null;
  const a = q.data;
  if (a?.project_id) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Link href={`/projets/${a.project_id}`} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-semibold text-white hover:bg-violet-strong">
          <FolderOpen size={13} /> Ouvrir le projet
        </Link>
        {a.status && <Badge tone={ONBOARDING_STATUS_TONES[a.status]}>{ONBOARDING_STATUS_LABELS[a.status]}</Badge>}
      </span>
    );
  }
  return (
    <Button size="sm" disabled={busy} onClick={() => win(companyId)}>
      <FolderOpen size={13} /> {busy ? "Création…" : "Créer le projet de cette vente"}
    </Button>
  );
}
