"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { renameCampaignAction, saveCampaignAsTemplateAction, setCampaignStatusAction } from "@/app/prospection-actions";
import { CampaignStatusBadge } from "@/components/prospection/bits";
import { Button, Card, Field, Input, Textarea } from "@/components/ui";
import type { CampaignOverview, CampaignStatus } from "@/lib/prospection/service";

export function CampaignSettings({ c, versions }: { c: CampaignOverview & { description: string | null }; versions: number[] }) {
  const router = useRouter();
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description ?? "");

  async function status(s: CampaignStatus, msg: string) {
    const r = await setCampaignStatusAction(c.id, s);
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    router.refresh();
  }

  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-base font-bold">Général</h2>
        <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description / objectif"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></Field>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={name === c.name && description === (c.description ?? "")}
            onClick={async () => {
              const r = await renameCampaignAction(c.id, name, description);
              if (!r.ok) return toast.error(r.error);
              toast.success("Enregistré");
              router.refresh();
            }}
          >
            Enregistrer
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-display text-base font-bold">Statut <CampaignStatusBadge status={c.status} /></h2>
        <ul className="space-y-1 text-xs text-muted">
          <li><strong className="text-ink">Brouillon</strong> : préparation, aucune action proposée.</li>
          <li><strong className="text-ink">Active</strong> : les actions dues apparaissent dans « Aujourd&apos;hui ».</li>
          <li><strong className="text-ink">En pause</strong> : historique et brouillons conservés ; actions non proposées ; échéances inchangées.</li>
          <li><strong className="text-ink">Terminée / archivée</strong> : plus aucune action proposée.</li>
        </ul>
        <div className="flex flex-wrap gap-1.5">
          {c.status !== "active" && c.status !== "archived" && <Button size="sm" onClick={() => status("active", "Campagne active")}>Activer / reprendre</Button>}
          {c.status === "active" && <Button size="sm" onClick={() => status("paused", "Campagne en pause")}>Mettre en pause</Button>}
          {(c.status === "active" || c.status === "paused") && <Button size="sm" onClick={() => status("finished", "Campagne terminée")}>Marquer terminée</Button>}
          {c.status !== "archived" ? (
            <Button size="sm" variant="danger" onClick={() => { if (confirm("Archiver la campagne ? L'historique reste consultable.")) status("archived", "Campagne archivée"); }}>Archiver</Button>
          ) : (
            <Button size="sm" onClick={() => status("paused", "Campagne désarchivée (en pause)")}>Désarchiver</Button>
          )}
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="font-display text-base font-bold">Règles d&apos;arrêt</h2>
        <ul className="space-y-1 text-sm">
          <li>· Une <strong>réponse enregistrée</strong> suspend les relances de l&apos;entreprise, pour tous ses contacts et toutes les campagnes.</li>
          <li>· <strong>Intéressé</strong> : vous choisissez un pipeline et une étape ; la prospection s&apos;arrête.</li>
          <li>· <strong>Pas intéressé</strong> arrête la prospection de l&apos;entreprise.</li>
          <li>· <strong>Ne plus contacter</strong> arrête tout et bloque toute nouvelle activation (visible sur la fiche).</li>
          <li>· Le <strong>passage en pipeline</strong> arrête les relances actives ; l&apos;historique reste consultable.</li>
        </ul>
        <p className="text-xs text-muted">Ces règles sont appliquées en base, de la même façon depuis l&apos;interface et depuis le connecteur Claude.</p>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="font-display text-base font-bold">Séquence</h2>
        <p className="text-sm">Version courante : <strong>v{c.current_version}</strong>{versions.length > 1 && ` · versions existantes : ${versions.map((v) => `v${v}`).join(", ")}`}</p>
        <p className="text-xs text-muted">Une modification de structure après démarrage crée une nouvelle version ; les participants démarrés terminent la leur, sans réinitialisation.</p>
        <Button
          size="sm"
          onClick={async () => {
            const n = prompt("Nom du modèle", c.name);
            if (!n) return;
            const r = await saveCampaignAsTemplateAction(c.id, n);
            if (!r.ok) return toast.error(r.error);
            toast.success("Modèle créé");
          }}
        >
          Enregistrer la séquence comme modèle
        </Button>
      </Card>
    </div>
  );
}
