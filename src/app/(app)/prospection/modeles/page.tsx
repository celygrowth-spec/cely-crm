import Link from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { STEP_META, type StepType } from "@/lib/prospection/steps";

import { TemplateRowActions } from "./row-actions";

export default async function ModelesPage() {
  const { supabase } = await requireOwner();
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, updated_at, template_steps(position, name, step_type, delay_days)")
    .order("name");
  if (error) return <p className="text-danger">{error.message}</p>;
  return (
    <div>
      <PageHeader
        title="Modèles de prospection"
        description="Une suite d'étapes manuelles réutilisable. Aucun envoi automatique."
        actions={<ButtonLink href="/prospection/modeles/nouveau" variant="primary"><Plus size={15} /> Nouveau modèle</ButtonLink>}
      />
      {!data?.length ? (
        <EmptyState
          title="Aucun modèle"
          description="Exemple : premier message LinkedIn, relance après 3 jours, email après 7 jours, dernière relance après 5 jours."
          action={<ButtonLink href="/prospection/modeles/nouveau" variant="primary"><Plus size={15} /> Créer un modèle</ButtonLink>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.map((t) => {
            const steps = [...(t.template_steps as { position: number; name: string; step_type: StepType; delay_days: number }[])].sort((a, b) => a.position - b.position);
            return (
              <Card key={t.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/prospection/modeles/${t.id}`} className="font-display text-base font-bold hover:text-violet-strong">{t.name}</Link>
                  <TemplateRowActions id={t.id} />
                </div>
                <ol className="mt-2 space-y-1 text-sm">
                  {steps.map((s) => (
                    <li key={s.position} className="flex gap-2">
                      <span className="w-5 font-label text-xs text-muted">{s.position}.</span>
                      <span className="flex-1">{s.name}</span>
                      <span className="text-xs text-muted">{STEP_META[s.step_type].label}{s.position > 1 ? ` · +${s.delay_days} j` : ""}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
