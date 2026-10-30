"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { renameCampaignAction, saveCampaignAsTemplateAction, saveSequenceAction } from "@/app/prospection-actions";
import { SequenceEditor, type PreviewContact } from "@/components/prospection/sequence-editor";
import { Button, Field, Input, Modal } from "@/components/ui";
import type { CampaignStatus } from "@/lib/prospection/service";
import type { SequenceStep } from "@/lib/prospection/steps";

export function CampaignSequence({
  campaignId, name, status, version, versionsInUse, steps, started, contacts,
}: {
  campaignId: string; name: string; status: CampaignStatus; version: number; versionsInUse: number[];
  steps: SequenceStep[]; started: number; contacts: PreviewContact[];
}) {
  const router = useRouter();
  const [tplSteps, setTplSteps] = useState<SequenceStep[] | null>(null);
  const [tplName, setTplName] = useState("");

  return (
    <>
      {versionsInUse.length > 1 && (
        <p className="mb-2 text-xs text-muted">
          Versions en cours d&apos;exécution : {versionsInUse.map((v) => `v${v}`).join(", ")}. L&apos;éditeur modifie la version {version} ; les participants des versions précédentes les terminent telles quelles.
        </p>
      )}
      <SequenceEditor
        title="Séquence"
        stickyTop="top-[5.4rem]"
        initialName={name}
        initialSteps={steps}
        startedOnCurrent={started}
        version={version}
        previewContacts={contacts}
        onSave={async (n, s) => {
          if (n.trim() !== name) {
            const r0 = await renameCampaignAction(campaignId, n);
            if (!r0.ok) return r0;
          }
          const r = await saveSequenceAction(campaignId, s);
          if (!r.ok) return r;
          router.refresh();
          return {
            ok: true,
            message: r.data.new_version
              ? `Version ${r.data.version} créée : ${r.data.kept_on_previous} participant(s) poursuivent la version précédente`
              : "Séquence enregistrée",
          };
        }}
        onSaveAsTemplate={async (s) => {
          setTplSteps(s);
          setTplName(name);
        }}
        extraActions={
          status === "draft" ? (
            <Button size="sm" onClick={() => router.push(`/prospection/campagnes/${campaignId}/preparation`)}>Ajouter des prospects →</Button>
          ) : undefined
        }
      />
      <Modal open={!!tplSteps} onClose={() => setTplSteps(null)} title="Enregistrer comme modèle">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await saveCampaignAsTemplateAction(campaignId, tplName);
            if (!r.ok) return toast.error(r.error);
            toast.success("Modèle créé à partir de la séquence enregistrée");
            setTplSteps(null);
          }}
          className="space-y-3"
        >
          <p className="text-sm text-muted">Le modèle reprend la dernière version <strong>enregistrée</strong> de la séquence. Enregistrez d&apos;abord vos modifications en cours.</p>
          <Field label="Nom du modèle"><Input value={tplName} onChange={(e) => setTplName(e.target.value)} required /></Field>
          <div className="flex justify-end"><Button type="submit" variant="primary">Créer le modèle</Button></div>
        </form>
      </Modal>
    </>
  );
}
