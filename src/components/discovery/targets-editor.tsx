"use client";

// Les 3 cibles de l'offre, préparées par moi dans le panneau de suivi. Tout peut rester vide (le client complète).
// Modifier une cible que le client a validée retire sa validation : il verra « Modifiée depuis ta validation ».
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, MessageSquare, PencilLine } from "lucide-react";
import { Badge, Button, Card, Input, Textarea } from "@/components/ui";
import { TARGET_FIELDS } from "@/lib/discovery/content";
import type { DiscoveryTarget, TargetField } from "@/lib/discovery/types";
import { discoveryOp } from "./admin-client";

type Draft = Record<TargetField, string>;
const toDraft = (t: DiscoveryTarget): Draft => Object.fromEntries(TARGET_FIELDS.map((f) => [f.key, t[f.key]])) as Draft;
const dt = (s: string) => new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });
const MAX: Record<TargetField, number> = { name: 120, sector: 300, company_size: 120, roles: 500, geography: 300, notes: 2000 };

export function TargetsEditor({ projectId, targets, onSaved }: { projectId: string; targets: DiscoveryTarget[]; onSaved: () => void }) {
  return (
    <Card className="p-4" data-discovery-targets>
      <h3 className="font-display text-base font-bold">Les 3 cibles</h3>
      <p className="mb-3 text-xs text-muted">
        Préremplissez ce que vous savez ; tout peut rester vide, le client complète les champs vides. Une cible déjà validée et modifiée ici perd sa validation.
      </p>
      <div className="grid gap-3 xl:grid-cols-3">
        {targets.map((t) => <TargetCard key={t.position} projectId={projectId} t={t} onSaved={onSaved} />)}
      </div>
    </Card>
  );
}

function TargetCard({ projectId, t, onSaved }: { projectId: string; t: DiscoveryTarget; onSaved: () => void }) {
  const server = JSON.stringify(toDraft(t));
  const [d, setD] = useState<Draft>(() => toDraft(t));
  const [base, setBase] = useState(server);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== base;
  // nouvelle version serveur (le client a complété un champ) : reprise seulement si rien n'est en cours de saisie ici
  if (!dirty && server !== base) {
    setD(JSON.parse(server) as Draft);
    setBase(server);
  }

  async function save() {
    if (t.validated_at && !window.confirm("Le client a validé cette cible. La modifier retire sa validation (il verra « Modifiée depuis ta validation »). Continuer ?")) return;
    setBusy(true);
    const r = await discoveryOp<{ validation_dropped?: boolean }>(projectId, { op: "target", position: t.position, data: d });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(r.data?.validation_dropped ? `Cible ${t.position} enregistrée : le client devra la revalider` : `Cible ${t.position} enregistrée`);
    setBase(JSON.stringify(d));
    onSaved();
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3" data-target={t.position}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-display text-sm font-bold">Cible {t.position}</span>
        {t.validated_at ? (
          <Badge tone="success"><CheckCircle2 size={11} className="mr-0.5 inline" aria-hidden />Validée{t.validated_by ? ` par ${t.validated_by}` : ""}</Badge>
        ) : t.modified_since_validation ? (
          <Badge tone="warning" data-target-modified>Modifiée depuis sa validation</Badge>
        ) : t.comments.length ? <Badge tone="violet">Commentée</Badge> : <Badge>À valider</Badge>}
      </div>
      {TARGET_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="flex flex-wrap items-center gap-1 text-[11px] font-semibold text-muted">
            {f.label}
            {t.client_filled.includes(f.key) && <span className="inline-flex items-center gap-0.5 text-violet-strong"><PencilLine size={10} aria-hidden /> rempli par le client</span>}
          </span>
          {f.multiline ? (
            <Textarea value={d[f.key]} maxLength={MAX[f.key]} className="min-h-16" placeholder={f.placeholder} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
          ) : (
            <Input value={d[f.key]} maxLength={MAX[f.key]} placeholder={f.placeholder} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!dirty || busy} onClick={save} data-target-save>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
        {dirty && <span className="text-xs text-muted">Non enregistré</span>}
      </div>
      {t.comments.length > 0 && (
        <div className="space-y-1.5 border-t border-line pt-2" data-target-comments>
          <p className="flex items-center gap-1 text-[11px] font-bold text-muted uppercase"><MessageSquare size={11} aria-hidden /> Commentaires du client</p>
          {t.comments.map((c) => (
            <p key={c.id} className="rounded-lg bg-surface px-2 py-1.5 text-sm whitespace-pre-wrap">
              {c.body}
              <span className="block text-[11px] text-muted">{c.by ?? "Client"} · {dt(c.at)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
