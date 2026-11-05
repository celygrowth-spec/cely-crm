"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, type Project } from "@/lib/projects/types";
import { CreateProjectModal } from "./projects/create-project";
import { Badge, Button, Skeleton } from "./ui";

export function RecordProjects({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["company-projects", companyId], queryFn: ({ signal }) => apiGet<Project[]>(`/api/fiches/${companyId}/projets`, signal) });
  if (q.isLoading) return <Skeleton className="h-10 w-full" />;
  return (
    <div className="space-y-2">
      {(q.data ?? []).map((p) => (
        <Link key={p.id} href={`/projets/${p.id}`} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-violet">
          <span className="flex-1 font-semibold text-ink">{p.name}</span>
          <Badge tone={PROJECT_STATUS_TONES[p.status]}>{PROJECT_STATUS_LABELS[p.status]}</Badge>
        </Link>
      ))}
      {q.data?.length === 0 && <p className="text-sm text-muted">Aucun projet.</p>}
      <Button size="sm" onClick={() => setOpen(true)}><Plus size={13} /> Nouveau projet</Button>
      <CreateProjectModal open={open} onClose={() => setOpen(false)} company={{ id: companyId, name: companyName }} />
    </div>
  );
}
