"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveTemplateStepsAction } from "@/app/prospection-actions";
import { SequenceEditor } from "@/components/prospection/sequence-editor";
import type { SequenceStep } from "@/lib/prospection/steps";

export function TemplateEditor({ id, name, steps }: { id: string | null; name: string; steps: SequenceStep[] }) {
  const router = useRouter();
  return (
    <div>
      <Link href="/prospection/modeles" className="mb-2 inline-block text-sm text-muted hover:text-ink">← Modèles</Link>
      <SequenceEditor
        title="Modèle"
        initialName={name}
        initialSteps={steps}
        onSave={async (n, s) => {
          const r = await saveTemplateStepsAction(id, n, s);
          if (!r.ok) return r;
          if (!id) router.replace(`/prospection/modeles/${r.data}`);
          else router.refresh();
          return { ok: true, message: "Modèle enregistré · les campagnes déjà créées ne changent pas" };
        }}
      />
    </div>
  );
}
