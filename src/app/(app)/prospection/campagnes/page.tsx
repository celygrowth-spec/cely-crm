import Link from "next/link";
import { Card, EmptyState, PageHeader, Badge } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import type { ParticipantStatus } from "@/lib/crm/types";
import { formatDate, PARTICIPANT_STATUS_LABELS } from "@/lib/format";
import { NewCampaign } from "./new-campaign";

export default async function CampagnesPage() {
  const { supabase } = await requireOwner();
  const [{ data: campaigns, error }, { data: templates }] = await Promise.all([
    supabase.from("campaigns").select("id, name, template_name, archived_at, created_at, campaign_participants(status)").order("created_at", { ascending: false }),
    supabase.from("templates").select("id, name").order("name"),
  ]);
  if (error) return <p className="text-danger">{error.message}</p>;
  const active = (campaigns ?? []).filter((c) => !c.archived_at);
  const archived = (campaigns ?? []).filter((c) => c.archived_at);
  const newBtn = <NewCampaign templates={templates ?? []} />;

  return (
    <div>
      <PageHeader title="Campagnes manuelles" description="Une session de prospection : un modèle, des listes, et l'avancement de chaque fiche." actions={newBtn} />
      {!campaigns?.length ? (
        <EmptyState
          title="Aucune campagne"
          description={templates?.length ? "Lancez une campagne à partir d'un modèle et d'une ou plusieurs listes." : "Créez d'abord un modèle de prospection, puis lancez une campagne."}
          action={templates?.length ? newBtn : <Link href="/prospection/modeles/nouveau" className="font-semibold text-violet-strong">Créer un modèle →</Link>}
        />
      ) : (
        <div className="space-y-6">
          {[["En cours", active], ["Archivées", archived]].map(([title, list]) =>
            (list as typeof active).length ? (
              <div key={title as string}>
                <h2 className="mb-2 font-label text-xs font-bold text-muted uppercase">{title as string}</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {(list as typeof active).map((c) => {
                    const counts = new Map<ParticipantStatus, number>();
                    (c.campaign_participants as { status: ParticipantStatus }[]).forEach((p) => counts.set(p.status, (counts.get(p.status) ?? 0) + 1));
                    return (
                      <Link key={c.id} href={`/prospection/campagnes/${c.id}`}>
                        <Card className="p-4 hover:border-violet">
                          <p className="font-display text-base font-bold">{c.name}</p>
                          <p className="text-xs text-muted">Modèle : {c.template_name ?? "—"} · lancée le {formatDate(c.created_at)}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {[...counts].map(([s, n]) => <Badge key={s} tone={s === "a_repondu" ? "success" : "neutral"}>{PARTICIPANT_STATUS_LABELS[s]} : {n}</Badge>)}
                            {!counts.size && <span className="text-xs text-muted">Aucun participant</span>}
                          </div>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
