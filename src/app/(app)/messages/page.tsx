// Messages : boîte de réception unifiée des comptes lemlist des clients (lecture). Réservé au propriétaire.
import { requireAppOwner } from "@/lib/auth";
import { MessagesView } from "./messages-view";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  await requireAppOwner();
  return <MessagesView />;
}
