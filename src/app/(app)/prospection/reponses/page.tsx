import { requireOwner } from "@/lib/auth";
import type { Interaction, Person } from "@/lib/crm/types";
import { RepliesList, type ReplyRow } from "./replies-list";

// Réponses enregistrées en attente de décision. Ce n'est pas une boîte de réception synchronisée.
export default async function ReponsesPage() {
  const { supabase } = await requireOwner();
  const { data: parts } = await supabase
    .from("campaign_participants")
    .select("id, company_id, person_id, status, outcome, current_step, sequence_version, updated_at, campaign:campaigns!inner(id, name), company:companies!inner(id, name, do_not_contact)")
    .eq("status", "a_repondu")
    .in("outcome", ["none", "replied"])
    .order("updated_at", { ascending: false })
    .limit(300);
  const rows = (parts ?? []) as unknown as Omit<ReplyRow, "reply" | "person">[];
  const ids = rows.map((r) => r.id);
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const [replies, people] = await Promise.all([
    ids.length ? supabase.from("interactions").select("*").in("company_id", companyIds).eq("kind", "message_in").order("occurred_at", { ascending: false }) : Promise.resolve({ data: [] }),
    companyIds.length ? supabase.from("people").select("*").in("company_id", companyIds) : Promise.resolve({ data: [] }),
  ]);
  const replyRows = (replies.data ?? []) as Interaction[];
  const peopleRows = (people.data ?? []) as Person[];
  const full: ReplyRow[] = rows.map((r) => ({
    ...r,
    reply: replyRows.find((x) => x.campaign_participant_id === r.id) ?? replyRows.find((x) => x.company_id === r.company_id) ?? null,
    person: peopleRows.find((p) => p.id === r.person_id) ?? null,
  }));
  return <RepliesList rows={full} />;
}
