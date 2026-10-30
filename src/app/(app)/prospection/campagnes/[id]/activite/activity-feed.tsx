"use client";

import { useState } from "react";
import { Bot, Inbox, Phone, Send, Target } from "lucide-react";
import { useCrm } from "@/components/app-shell";
import { Badge, EmptyState, cn } from "@/components/ui";
import type { Interaction } from "@/lib/crm/types";
import { CHANNEL_LABELS, formatDateTime, KIND_LABELS } from "@/lib/format";

const FILTERS = [
  ["all", "Tout"],
  ["message_out", "Envoyés"],
  ["message_in", "Réponses"],
  ["call", "Appels"],
  ["prospecting", "Actions et résultats"],
] as const;

export function ActivityFeed({ rows, companies, people }: { rows: Interaction[]; companies: Record<string, string>; people: Record<string, string> }) {
  const { openCompany } = useCrm();
  const [f, setF] = useState<(typeof FILTERS)[number][0]>("all");
  const shown = rows.filter((r) => f === "all" || r.kind === f || (f === "prospecting" && (r.kind === "stage_change" || r.kind === "deal_status")));
  if (!rows.length) return <EmptyState title="Aucune activité" description="Les envois, appels, réponses et résultats enregistrés pour cette campagne apparaîtront ici." />;
  return (
    <div>
      <div className="mb-3 flex gap-1">
        {FILTERS.map(([k, l]) => (
          <button key={k} onClick={() => setF(k)} className={cn("rounded-md px-2 py-1 text-xs font-semibold", f === k ? "bg-ink text-white" : "text-muted hover:bg-surface")}>
            {l} <span className="opacity-70">{k === "all" ? rows.length : rows.filter((r) => r.kind === k).length}</span>
          </button>
        ))}
      </div>
      <ol className="divide-y divide-line rounded-xl border border-line">
        {shown.map((r) => {
          const meta = r.meta as { step_name?: string; step_position?: number; subject?: string };
          const Icon = r.kind === "message_in" ? Inbox : r.kind === "message_out" ? Send : r.kind === "call" ? Phone : Target;
          return (
            <li key={r.id} className="flex gap-3 px-3 py-2">
              <Icon size={15} className={cn("mt-0.5 shrink-0", r.kind === "message_in" ? "text-success" : "text-violet-strong")} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">
                  <button className="font-semibold text-ink hover:text-violet-strong" onClick={() => openCompany(r.company_id)}>{companies[r.company_id] ?? "Fiche"}</button>
                  {r.person_id && people[r.person_id] && ` · ${people[r.person_id]}`} · {KIND_LABELS[r.kind]}
                  {r.channel && ` · ${CHANNEL_LABELS[r.channel]}`}
                  {meta.step_position && ` · étape ${meta.step_position}${meta.step_name ? ` (${meta.step_name})` : ""}`} · {formatDateTime(r.occurred_at)}
                  {r.source === "claude" && <Badge tone="violet" className="ml-1"><Bot size={10} /> Claude</Badge>}
                </p>
                {meta.subject && <p className="text-sm"><span className="text-muted">Objet : </span>{meta.subject}</p>}
                {r.content && <p className="line-clamp-3 text-sm whitespace-pre-wrap">{r.content}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
