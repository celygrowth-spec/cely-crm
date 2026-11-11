import { EmptyState, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { InboundToLink, type InboundRow } from "./to-link";

// Emails reçus d'une adresse présente sur plusieurs fiches : à rattacher à la main (Q03). Rien n'est deviné.
export default async function EmailsToLinkPage() {
  const { supabase } = await requireOwner();
  const { data } = await supabase.from("mail_messages")
    .select("id, from_addr, subject, body_text, received_at, link_candidates, attachments_meta")
    .eq("direction", "in").eq("link_state", "to_link").order("received_at", { ascending: false }).limit(100);
  const rows = (data ?? []) as InboundRow[];
  return (
    <div className="max-w-4xl">
      <PageHeader title="Emails à rattacher" description="Réponses reçues d'une adresse présente sur plusieurs fiches. Choisissez la bonne : l'échange s'ajoute à son historique." />
      {rows.length ? <InboundToLink rows={rows} /> : <EmptyState title="Aucun email à rattacher" description="Les réponses de vos contacts sont rattachées automatiquement quand l'adresse ne correspond qu'à une fiche." />}
    </div>
  );
}
