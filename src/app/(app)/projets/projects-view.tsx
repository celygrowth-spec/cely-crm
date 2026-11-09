"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, type Project } from "@/lib/projects/types";
import { CreateProjectModal } from "@/components/projects/create-project";

export function ProjectsView({ projects, archived, openCreate, company }: { projects: Project[]; archived: boolean; openCreate: boolean; company?: { id: string; name: string } }) {
  const router = useRouter();
  const [creating, setCreating] = useState(openCreate);
  return (
    <div>
      <PageHeader
        title="Projets"
        description="Projets clients et espace partagé avec chaque client."
        actions={
          <>
            <Link href={archived ? "/projets" : "/projets?archives=1"} className="text-sm font-semibold text-muted hover:text-ink">{archived ? "Projets actifs" : "Archives"}</Link>
            <Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} /> Nouveau projet</Button>
          </>
        }
      />
      {projects.length === 0 ? (
        <EmptyState
          title={archived ? "Aucun projet archivé" : "Aucun projet"}
          description={archived ? undefined : "Créez un projet à partir d'une fiche CRM : le client y retrouvera l'avancement, les points, ses tâches et les fichiers."}
          action={!archived && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} /> Nouveau projet</Button>}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b border-line bg-surface text-left font-label text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Projet</th>
                <th className="px-3 py-2 font-semibold">Client</th>
                <th className="px-3 py-2 font-semibold">Statut</th>
                <th className="px-3 py-2 font-semibold">Phase actuelle</th>
                <th className="px-3 py-2 font-semibold">Prochain point</th>
                <th className="px-3 py-2 font-semibold">Tâches client ouvertes</th>
                <th className="px-3 py-2 font-semibold">Portail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {projects.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-surface" onClick={() => router.push(`/projets/${p.id}`)}>
                  <td className="px-3 py-2.5">
                    <Link href={`/projets/${p.id}`} className="font-semibold text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                    {p.blocked_reason && <span className="mt-0.5 flex items-center gap-1 text-xs text-warning"><AlertTriangle size={12} /> {p.blocked_reason}</span>}
                  </td>
                  <td className="px-3 py-2.5">{p.company_name}</td>
                  <td className="px-3 py-2.5"><Badge tone={PROJECT_STATUS_TONES[p.status]}>{PROJECT_STATUS_LABELS[p.status]}</Badge></td>
                  <td className="px-3 py-2.5 text-muted">{p.current_phase_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-muted">{p.next_meeting_at ? formatDate(p.next_meeting_at) : "—"}</td>
                  <td className="px-3 py-2.5 text-muted tabular-nums">{p.open_client_tasks ?? 0}</td>
                  <td className="px-3 py-2.5">{p.portal_published ? <Badge tone="success">Publié</Badge> : <Badge>Non publié</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateProjectModal open={creating} onClose={() => setCreating(false)} company={company} />
    </div>
  );
}
