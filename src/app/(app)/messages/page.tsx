// Messages : boîte de réception des comptes lemlist des clients, par client. Réservé au propriétaire.
//  /messages                              grille des clients actifs
//  /messages?client=<fiche>               conversations de ce client
//  /messages?conversation=<id>            lien direct : retrouve le client de la conversation et ouvre son fil
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAppOwner } from "@/lib/auth";
import { MessagesView } from "./messages-view";

export const dynamic = "force-dynamic";

const uuid = (v: unknown) => (typeof v === "string" && z.uuid().safeParse(v).success ? v : null);

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ client?: string; conversation?: string }> }) {
  const session = await requireAppOwner();
  const sp = await searchParams;
  const client = uuid(sp.client);
  const conversation = uuid(sp.conversation);
  if (conversation && !client) {
    // le client est celui de la conversation, retrouvé au CRM (jamais pris de l'adresse)
    const { data } = await session.supabase.rpc("lemlist_conversation_get", { p_id: conversation });
    const company = uuid((data as { company_id?: unknown } | null)?.company_id);
    redirect(company ? `/messages?client=${company}&conversation=${conversation}` : "/messages");
  }
  return <MessagesView key={client ?? "all"} client={client} conversation={client ? conversation : null} />;
}
