"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { addListsToCampaignAction, archiveCampaignAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { ParticipantActions } from "@/components/participant-actions";
import { Badge, Button, EmptyState, Modal, PageHeader, Select, cn } from "@/components/ui";
import type { CampaignStep, ParticipantStatus, Person } from "@/lib/crm/types";
import { CHANNEL_LABELS, PARTICIPANT_STATUS_LABELS, personName, relativeDay, todayISO } from "@/lib/format";

export type Row = {
  id: string;
  company_id: string;
  company_name: string;
  archived: boolean;
  person_id: string | null;
  current_step: number;
  status: ParticipantStatus;
  next_due_date: string | null;
  stop_reason: string | null;
  steps: CampaignStep[];
  people: Person[];
  last: { kind: string; content: string | null; occurred_at: string } | null;
};

const tone = { a_contacter: "violet", en_cours: "violet", a_repondu: "success", termine: "neutral", arrete: "neutral" } as const;

export function CampaignView({
  campaign,
  steps,
  rows,
}: {
  campaign: { id: string; name: string; template_name: string | null; archived: boolean; listIds: string[] };
  steps: CampaignStep[];
  rows: Row[];
}) {
  const { lists, openCompany } = useCrm();
  const router = useRouter();
  const [status, setStatus] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const today = todayISO();
  const shown = rows.filter((r) => !status || r.status === status);

  async function addLists() {
    const res = await addListsToCampaignAction(campaign.id, picked);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data.added} fiche(s) ajoutée(s)${res.data.already_present ? `, ${res.data.already_present} déjà présente(s)` : ""}`);
    setAddOpen(false);
    router.refresh();
  }
  async function archive() {
    const res = await archiveCampaignAction(campaign.id, !campaign.archived);
    if (!res.ok) return toast.error(res.error);
    router.refresh();
  }

  return (
    <div>
      <PageHeader
        title={campaign.name}
        description={`Modèle : ${campaign.template_name ?? "—"} · ${steps.map((s) => `${s.position}. ${s.name} (${CHANNEL_LABELS[s.channel]}${s.position > 1 ? `, +${s.delay_days} j` : ""})`).join(" → ")}`}
        actions={
          <>
            <Link href="/prospection/campagnes" className="text-sm font-semibold text-muted hover:text-ink">← Campagnes</Link>
            {!campaign.archived && <Button onClick={() => { setPicked([]); setAddOpen(true); }}><Plus size={14} /> Ajouter des listes</Button>}
            <Button variant="ghost" onClick={archive}>{campaign.archived ? "Désarchiver" : "Archiver"}</Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Filtrer par statut">
          <option value="">Tous les statuts ({rows.length})</option>
          {Object.entries(PARTICIPANT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v} ({rows.filter((r) => r.status === k).length})</option>)}
        </Select>
        {campaign.archived && <Badge tone="warning">Campagne archivée : actions désactivées</Badge>}
      </div>
      {!rows.length ? (
        <EmptyState title="Aucun participant" description="Ajoutez une ou plusieurs listes, ou sélectionnez des fiches dans la base." action={!campaign.archived && <Button variant="primary" onClick={() => setAddOpen(true)}>Ajouter des listes</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-line bg-surface text-left font-label text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Entreprise</th>
                <th className="px-3 py-2">Personne ciblée</th>
                <th className="px-3 py-2">Étape actuelle</th>
                <th className="px-3 py-2">Dernier message</th>
                <th className="px-3 py-2">Relance</th>
                <th className="px-3 py-2">Statut</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => {
                const step = steps.find((s) => s.position === r.current_step);
                const person = r.people.find((p) => p.id === r.person_id);
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2">
                      <button onClick={() => openCompany(r.company_id)} className="font-semibold hover:text-violet-strong">{r.company_name}</button>
                      {r.archived && <Badge className="ml-1">archivée</Badge>}
                    </td>
                    <td className="px-3 py-2">{person ? personName(person) : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2">{step ? `${step.position}/${steps.length} · ${step.name}` : <span className="text-muted">Terminé</span>}</td>
                    <td className="max-w-56 px-3 py-2">
                      {r.last ? (
                        <div>
                          <p className="text-xs text-muted">{r.last.kind === "message_in" ? "Reçu" : "Envoyé"} · {relativeDay(r.last.occurred_at)}</p>
                          <p className="line-clamp-2 text-xs">{r.last.content}</p>
                        </div>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className={cn("px-3 py-2 whitespace-nowrap", r.next_due_date && r.next_due_date < today && "font-semibold text-danger")}>
                      {r.next_due_date ? relativeDay(r.next_due_date) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={tone[r.status]}>{PARTICIPANT_STATUS_LABELS[r.status]}</Badge>
                      {r.status === "arrete" && r.stop_reason && <p className="mt-1 text-xs text-muted">{r.stop_reason}</p>}
                    </td>
                    <td className="px-3 py-2">
                      {!campaign.archived && <ParticipantActions p={r} people={r.people} onChanged={() => router.refresh()} compact />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Ajouter des listes à la campagne">
        <div className="space-y-1">
          {lists.map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id)))} />
              {l.name} {campaign.listIds.includes(l.id) && <span className="text-xs text-muted">(déjà ajoutée)</span>}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Les fiches déjà présentes ne sont pas ajoutées une deuxième fois.</p>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={addLists} disabled={!picked.length}>Ajouter</Button></div>
      </Modal>
    </div>
  );
}
