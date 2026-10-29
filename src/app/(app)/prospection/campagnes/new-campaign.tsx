"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createCampaignAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Button, Field, Input, Modal, Select } from "@/components/ui";

export function NewCampaign({ templates }: { templates: { id: string; name: string }[] }) {
  const { lists } = useCrm();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [listIds, setListIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  if (!templates.length) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await createCampaignAction(name, templateId, listIds);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Campagne créée${res.data.added != null ? ` : ${res.data.added} fiche(s)` : ""}${res.data.already_present ? ` (${res.data.already_present} doublon(s) de listes ignoré(s))` : ""}`);
    setOpen(false);
    router.push(`/prospection/campagnes/${res.data.id}`);
  }

  return (
    <>
      <Button variant="primary" onClick={() => { setOpen(true); setTemplateId(templates[0].id); setName(""); setListIds([]); }}>
        <Plus size={15} /> Nouvelle campagne
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Nouvelle campagne">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fondateurs SaaS – novembre" /></Field>
          <Field label="Modèle *" hint="Les étapes sont copiées : modifier le modèle plus tard ne changera pas cette campagne.">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Listes" hint="Une entreprise présente dans plusieurs listes n'est ajoutée qu'une fois.">
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {lists.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={listIds.includes(l.id)} onChange={(e) => setListIds((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id)))} />
                  {l.name}
                </label>
              ))}
              {!lists.length && <p className="text-sm text-muted">Aucune liste. Vous pourrez ajouter des fiches depuis la base.</p>}
            </div>
          </Field>
          <div className="flex justify-end"><Button type="submit" variant="primary" disabled={pending || !templateId}>Lancer la campagne</Button></div>
        </form>
      </Modal>
    </>
  );
}
