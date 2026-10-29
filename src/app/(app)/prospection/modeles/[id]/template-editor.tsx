"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { saveTemplateAction } from "@/app/actions";
import { Button, Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import type { CampaignStep, Channel } from "@/lib/crm/types";
import { CHANNEL_LABELS } from "@/lib/format";

type Step = { name: string; channel: Channel; delay_days: number; message: string };

export function TemplateEditor({ id, initialName, initialSteps }: { id: string | null; initialName: string; initialSteps: CampaignStep[] }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [steps, setSteps] = useState<Step[]>(
    initialSteps.length
      ? initialSteps.map((s) => ({ name: s.name, channel: s.channel, delay_days: s.delay_days, message: s.message ?? "" }))
      : [{ name: "Premier message", channel: "linkedin", delay_days: 0, message: "" }],
  );
  const [pending, setPending] = useState(false);

  const set = (i: number, patch: Partial<Step>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((ss) => {
      const n = [...ss];
      const [x] = n.splice(i, 1);
      n.splice(i + d, 0, x);
      return n;
    });

  async function save() {
    setPending(true);
    const res = await saveTemplateAction(id, name, steps);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Modèle enregistré. Les campagnes déjà lancées ne sont pas modifiées.");
    router.push("/prospection/modeles");
    router.refresh();
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={id ? "Modifier le modèle" : "Nouveau modèle"}
        description="Les variables {prénom} et {entreprise} sont remplacées lors de la préparation du message."
        actions={<Link href="/prospection/modeles" className="text-sm font-semibold text-muted hover:text-ink">← Modèles</Link>}
      />
      <Field label="Nom du modèle *"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Séquence LinkedIn fondateurs" /></Field>
      <div className="mt-4 space-y-3">
        {steps.map((s, i) => (
          <Card key={i} className="p-3">
            <div className="flex items-center justify-between">
              <p className="font-label text-xs font-bold text-muted">ÉTAPE {i + 1}</p>
              <div className="flex">
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter"><ArrowUp size={14} /></Button>
                <Button size="sm" variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Descendre"><ArrowDown size={14} /></Button>
                <Button size="sm" variant="ghost" disabled={steps.length === 1} onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))} aria-label="Supprimer"><Trash2 size={14} /></Button>
              </div>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
              <Field label="Nom"><Input value={s.name} onChange={(e) => set(i, { name: e.target.value })} /></Field>
              <Field label="Canal">
                <Select value={s.channel} onChange={(e) => set(i, { channel: e.target.value as Channel })}>
                  {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label={i === 0 ? "Délai après ajout (j)" : "Délai après l'étape précédente (j)"}>
                <Input type="number" min={0} max={365} value={s.delay_days} onChange={(e) => set(i, { delay_days: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
            </div>
            <Field label="Texte du message (facultatif)" className="mt-2">
              <Textarea value={s.message} onChange={(e) => set(i, { message: e.target.value })} rows={4} placeholder="Bonjour {prénom}, …" />
            </Field>
          </Card>
        ))}
      </div>
      <div className="mt-3 flex justify-between">
        <Button onClick={() => setSteps((ss) => [...ss, { name: `Relance ${ss.length}`, channel: "linkedin", delay_days: 3, message: "" }])}>
          <Plus size={14} /> Ajouter une étape
        </Button>
        <Button variant="primary" onClick={save} disabled={pending || !name.trim()}>Enregistrer le modèle</Button>
      </div>
    </div>
  );
}
