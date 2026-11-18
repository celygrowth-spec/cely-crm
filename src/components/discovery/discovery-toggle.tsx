"use client";

// Réglage de l'espace client : case « Offre découverte ». Enregistrée immédiatement (indépendante du bouton
// « Enregistrer » du projet). Décocher masque l'onglet du client sans rien effacer.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { discoveryOp, useDiscoveryAdmin, useRefreshDiscovery } from "./admin-client";

export function DiscoveryToggle({ projectId }: { projectId: string }) {
  const q = useDiscoveryAdmin(projectId);
  const refresh = useRefreshDiscovery(projectId);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const enabled = !!q.data?.enabled;
  const suggested = q.data && !q.data.exists && q.data.suggested;

  async function toggle(next: boolean) {
    setBusy(true);
    const r = await discoveryOp(projectId, { op: "enable", enabled: next });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(next ? "Offre découverte activée : l'onglet Onboarding apparaît chez le client" : "Onglet Onboarding masqué : les réponses sont conservées");
    await refresh();
    router.refresh();
  }

  return (
    <div className="border-t border-line pt-3" data-discovery-toggle>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={enabled} disabled={busy || q.isLoading} onChange={(e) => toggle(e.target.checked)} data-discovery-checkbox />
        <span>
          <strong>Offre découverte</strong>
          <span className="block text-xs text-muted">
            Test à 500 € (300 contacts, 3 cibles, 28 jours). Ajoute l&apos;onglet <em>Onboarding</em> au portail de ce client.
            {q.data?.exists && q.data.enabled_source === "sale" && " Cochée d'après la vente."}
          </span>
        </span>
      </label>
      {suggested && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-violet-strong"><Sparkles size={12} aria-hidden /> La vente liée s&apos;appelle « offre découverte » : cochez la case pour lancer l&apos;onboarding.</p>
      )}
      {enabled && q.data?.exists && (
        <p className="mt-2 text-xs text-muted" data-discovery-summary>
          <strong className="text-ink">{q.data.sent_at ? "Onboarding envoyé" : q.data.started_at ? "Onboarding en cours" : "Onboarding non commencé"}</strong>
          {" · "}{q.data.targets.filter((t) => t.validated_at).length}/3 cibles validées
          {(() => { const n = q.data.targets.reduce((k, t) => k + t.comments.length, 0); return n ? ` · ${n} commentaire${n > 1 ? "s" : ""}` : ""; })()}
          {q.data.changed_after_send_at && " · modifié après envoi"}
        </p>
      )}
      {enabled && (
        <Link href={`/projets/${projectId}/onboarding-decouverte`} className="mt-1 inline-block text-xs font-semibold text-violet-strong hover:underline">Ouvrir le suivi de l&apos;onboarding →</Link>
      )}
    </div>
  );
}
