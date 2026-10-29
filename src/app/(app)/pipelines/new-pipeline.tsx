"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createPipelineAction } from "@/app/actions";
import { Button, Field, Input, Modal, Textarea } from "@/components/ui";

export function NewPipeline({ primary }: { primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [stages, setStages] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await createPipelineAction(name, stages.split("\n"));
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    setOpen(false);
    router.push(`/pipelines/${res.data.id}`);
  }

  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} onClick={() => { setOpen(true); setName(""); setStages(""); }}>
        <Plus size={15} /> {primary ? "Créer un pipeline" : "Nouveau pipeline"}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Nouveau pipeline">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Nom *"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
          <Field label="Étapes *" hint="Une étape par ligne, dans l'ordre.">
            <Textarea value={stages} onChange={(e) => setStages(e.target.value)} rows={5} required />
          </Field>
          <div className="flex justify-end"><Button type="submit" variant="primary" disabled={pending}>Créer</Button></div>
        </form>
      </Modal>
    </>
  );
}
