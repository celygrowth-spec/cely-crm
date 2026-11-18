"use client";

// Les 3 cibles de l'offre, vues du panneau de suivi (lot 1 : lecture ; la préparation arrive au lot 2).
import { Badge, Card } from "@/components/ui";
import { TARGET_FIELDS } from "@/lib/discovery/content";
import type { DiscoveryTarget } from "@/lib/discovery/types";

export function TargetsEditor({ targets }: { projectId: string; targets: DiscoveryTarget[]; onSaved: () => void }) {
  return (
    <Card className="p-4" data-discovery-targets>
      <h3 className="mb-3 font-display text-base font-bold">Les 3 cibles</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {targets.map((t) => (
          <div key={t.position} className="rounded-lg border border-line p-3 text-sm">
            <p className="font-semibold">Cible {t.position}{t.name ? ` · ${t.name}` : ""}</p>
            {t.validated_at ? <Badge tone="success">Validée</Badge> : <Badge>Non validée</Badge>}
            <dl className="mt-2 space-y-1">
              {TARGET_FIELDS.filter((f) => f.key !== "name").map((f) => (
                <div key={f.key}><dt className="text-[11px] text-muted">{f.label}</dt><dd>{t[f.key] || "—"}</dd></div>
              ))}
            </dl>
            {t.comments.map((c) => <p key={c.id} className="mt-2 rounded bg-surface px-2 py-1 text-xs">« {c.body} » — {c.by ?? "Client"}</p>)}
          </div>
        ))}
      </div>
    </Card>
  );
}
