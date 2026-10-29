"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { mergeCompaniesAction } from "@/app/actions";
import { Button, Card, PageHeader, cn } from "@/components/ui";
import type { CompanyDetail } from "@/lib/crm/types";
import { formatAmount, formatDate, personName, PROSPECT_STATUS_LABELS } from "@/lib/format";

const FIELDS = [
  ["name", "Nom"],
  ["website", "Site web"],
  ["description", "Description"],
  ["source_id", "Source"],
  ["prospect_status", "Statut de prospection"],
  ["amount", "Montant"],
  ["expected_close_date", "Closing estimé"],
  ["lost_reason", "Motif de perte"],
] as const;

function display(d: CompanyDetail, f: (typeof FIELDS)[number][0]): string {
  const c = d.company;
  switch (f) {
    case "source_id": return c.source?.name ?? "";
    case "prospect_status": return PROSPECT_STATUS_LABELS[c.prospect_status];
    case "amount": return formatAmount(c.amount);
    case "expected_close_date": return c.expected_close_date ? formatDate(c.expected_close_date) : "";
    default: return (c[f] as string | null) ?? "";
  }
}

export function MergeForm({ a, b }: { a: CompanyDetail; b: CompanyDetail }) {
  const router = useRouter();
  const [keepA, setKeepA] = useState(true);
  const keep = keepA ? a : b;
  const merged = keepA ? b : a;
  const conflicts = FIELDS.filter(([f]) => display(a, f) && display(b, f) && display(a, f) !== display(b, f));
  const [choices, setChoices] = useState<Record<string, "a" | "b">>({});
  const bothPipelines = !!a.company.pipeline && !!b.company.pipeline && a.company.stage_id !== b.company.stage_id;
  const [pipelineFromA, setPipelineFromA] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    const fields: Record<string, "keep" | "merged"> = {};
    for (const [f] of conflicts) {
      const pick = choices[f] ?? (keepA ? "a" : "b");
      fields[f] = (pick === "a") === keepA ? "keep" : "merged";
    }
    // champ vide côté conservé : on récupère la valeur de l'autre fiche (géré côté serveur)
    const pipelineFrom = !bothPipelines ? (keep.company.pipeline ? "keep" : merged.company.pipeline ? "merged" : "keep") : pipelineFromA === keepA ? "keep" : "merged";
    const res = await mergeCompaniesAction(keep.company.id, merged.company.id, fields, pipelineFrom);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Fusion effectuée : ${res.data.people_moved} personne(s) rattachée(s)${res.data.campaign_conflicts ? `, ${res.data.campaign_conflicts} conflit(s) de campagne consigné(s)` : ""}`);
    router.push(`/fiches/${res.data.kept_id}`);
  }

  const side = (d: CompanyDetail, isA: boolean) => (
    <Card className={cn("p-4", (isA ? keepA : !keepA) && "border-violet ring-2 ring-violet/20")}>
      <label className="flex items-center gap-2 font-display text-base font-bold">
        <input type="radio" checked={isA ? keepA : !keepA} onChange={() => setKeepA(isA)} />
        {d.company.name}
      </label>
      <p className="mt-1 text-xs text-muted">Créée le {formatDate(d.company.created_at)} · {d.people.length} personne(s) · {d.interactions.length} entrée(s) d&apos;historique · {d.tasks.length} tâche(s)</p>
      <p className="text-xs text-muted">Listes : {d.lists.map((l) => l.name).join(", ") || "—"} · Campagnes : {d.participants.length}</p>
      <p className="text-xs text-muted">Pipeline : {d.company.pipeline ? `${d.company.pipeline.name} › ${d.company.stage?.name}` : "—"}</p>
      <p className="mt-2 text-xs">{d.people.map((p) => personName(p)).join(", ")}</p>
    </Card>
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Fusionner deux fiches" description="Choisissez la fiche conservée. Personnes, notes, messages, tâches, listes et historique des deux fiches sont conservés." actions={<Link href="/prospection/doublons" className="text-sm font-semibold text-muted">← Doublons</Link>} />
      <div className="grid gap-3 md:grid-cols-2">
        {side(a, true)}
        {side(b, false)}
      </div>

      {conflicts.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="font-display text-base font-bold">Conflits de champs</h2>
          <p className="text-sm text-muted">Les champs vides sont complétés automatiquement avec la valeur de l&apos;autre fiche.</p>
          <table className="mt-2 w-full text-sm">
            <tbody className="divide-y divide-line">
              {conflicts.map(([f, label]) => {
                const pick = choices[f] ?? (keepA ? "a" : "b");
                return (
                  <tr key={f}>
                    <td className="py-2 pr-3 font-label text-xs text-muted">{label}</td>
                    {(["a", "b"] as const).map((side) => (
                      <td key={side} className="py-2 pr-3">
                        <label className="flex items-start gap-2">
                          <input type="radio" checked={pick === side} onChange={() => setChoices({ ...choices, [f]: side })} className="mt-1" />
                          <span className="line-clamp-3">{display(side === "a" ? a : b, f)}</span>
                        </label>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {bothPipelines && (
        <Card className="mt-4 p-4">
          <h2 className="font-display text-base font-bold">Les deux fiches sont dans un pipeline</h2>
          <p className="text-sm text-muted">Une fiche ne peut avoir qu&apos;une opportunité active. L&apos;autre position sera consignée dans l&apos;historique.</p>
          {[a, b].map((d, i) => (
            <label key={d.company.id} className="mt-2 flex items-center gap-2 text-sm">
              <input type="radio" checked={pipelineFromA === (i === 0)} onChange={() => setPipelineFromA(i === 0)} />
              {d.company.pipeline!.name} › {d.company.stage?.name} ({d.company.deal_status === "open" ? "ouvert" : d.company.deal_status === "won" ? "gagné" : "perdu"})
            </label>
          ))}
        </Card>
      )}

      <Card className="mt-4 p-4">
        <p className="text-sm">
          La fiche <strong>{merged.company.name}</strong> sera fusionnée dans <strong>{keep.company.name}</strong>. L&apos;ancien identifiant est conservé et redirige vers la fiche gardée.
          Les participations en double à une même campagne sont arrêtées et consignées dans l&apos;historique.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Je confirme la fusion
        </label>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" disabled={!confirmed || pending} onClick={submit}>{pending ? "Fusion…" : "Fusionner"}</Button>
        </div>
      </Card>
    </div>
  );
}
