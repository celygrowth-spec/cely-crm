"use client";

// Informations générales : ce que le client voit est séparé visuellement de ce qui reste interne.
import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { updateProjectAction } from "@/app/projets-actions";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { PROJECT_STATUS_LABELS, type Project, type ProjectStatus } from "@/lib/projects/types";

export function VisibilityTag({ client }: { client: boolean }) {
  return client ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-soft px-2 py-0.5 font-label text-[10px] font-semibold text-violet-strong"><Eye size={11} /> Visible du client</span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 font-label text-[10px] font-semibold text-muted"><EyeOff size={11} /> Interne</span>
  );
}

export function ProjectGeneral({ project: p }: { project: Project }) {
  const sync = useSync();
  const [d, setD] = useState({
    name: p.name, description: p.description ?? "", status: p.status, start_date: p.start_date ?? "", end_date: p.end_date ?? "",
    client_update: p.client_update ?? "", internal_note: p.internal_note ?? "", blocked_reason: p.blocked_reason ?? "",
    portal_published: p.portal_published, archived_portal: p.archived_portal,
  });
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify({
    name: p.name, description: p.description ?? "", status: p.status, start_date: p.start_date ?? "", end_date: p.end_date ?? "",
    client_update: p.client_update ?? "", internal_note: p.internal_note ?? "", blocked_reason: p.blocked_reason ?? "",
    portal_published: p.portal_published, archived_portal: p.archived_portal,
  });

  async function save() {
    setBusy(true);
    const r = await attempt(() => updateProjectAction(p.id, { ...d, start_date: d.start_date || null, end_date: d.end_date || null }));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Projet enregistré");
    sync();
  }

  return (
    <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between"><h2 className="font-display text-base font-bold">Projet</h2><VisibilityTag client /></div>
        <Field label="Nom"><Input value={d.name} maxLength={160} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Description courte"><Textarea value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })} className="min-h-16" /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Statut">
            <Select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as ProjectStatus })}>
              {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}
            </Select>
          </Field>
          <Field label="Début"><Input type="date" value={d.start_date} onChange={(e) => setD({ ...d, start_date: e.target.value })} /></Field>
          <Field label="Fin prévue"><Input type="date" value={d.end_date} onChange={(e) => setD({ ...d, end_date: e.target.value })} /></Field>
        </div>
        <Field label="Où en sommes-nous ? (message affiché en tête du portail)">
          <Textarea value={d.client_update} maxLength={2000} onChange={(e) => setD({ ...d, client_update: e.target.value })} placeholder="Ex. : la maquette est validée, nous passons à la production des pages." />
        </Field>
      </Card>
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between"><h2 className="font-display text-base font-bold">Portail client</h2><VisibilityTag client /></div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={d.portal_published} onChange={(e) => setD({ ...d, portal_published: e.target.checked })} />
            <span><strong>Publier le projet sur le portail</strong><span className="block text-xs text-muted">Tant qu&apos;il n&apos;est pas publié, les contacts disposant d&apos;un code ne le voient pas.</span></span>
          </label>
          {d.status === "archive" && (
            <Field label="Après archivage">
              <Select value={d.archived_portal} onChange={(e) => setD({ ...d, archived_portal: e.target.value as "read_only" | "closed" })}>
                <option value="read_only">Le client garde un accès en lecture seule</option>
                <option value="closed">Le client n&apos;y a plus accès</option>
              </Select>
            </Field>
          )}
        </Card>
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between"><h2 className="font-display text-base font-bold">Notes internes</h2><VisibilityTag client={false} /></div>
          <Field label="Blocage éventuel (affiché dans votre liste de projets)"><Input value={d.blocked_reason} maxLength={500} onChange={(e) => setD({ ...d, blocked_reason: e.target.value })} placeholder="Ex. : attente des contenus" /></Field>
          <Field label="Note interne"><Textarea value={d.internal_note} maxLength={10000} onChange={(e) => setD({ ...d, internal_note: e.target.value })} /></Field>
        </Card>
      </div>
      <div className="sticky bottom-16 flex gap-2 rounded-xl border border-line bg-white/95 p-3 backdrop-blur md:bottom-4 lg:col-span-2">
        <Button variant="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
        {dirty && <span className="self-center text-xs text-muted">Modifications non enregistrées</span>}
      </div>
    </div>
  );
}
