// Paramètres › Connecteurs : ce qui est relié au CRM, en un coup d'œil. États lus en base à
// l'ouverture (aucun appel aux fournisseurs) ; chaque service se vérifie ensuite à la demande.
import { headers } from "next/headers";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireAppOwner } from "@/lib/auth";
import { loadConnectors } from "@/lib/connectors/status";
import { ConnectorsView } from "./connectors-view";

export const dynamic = "force-dynamic";

export default async function ConnecteursPage() {
  const { supabase } = await requireAppOwner();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const connectors = await loadConnectors(supabase, `${proto}://${host}/api/mcp`);
  return (
    <div className="max-w-3xl">
      <Link href="/parametres" className="text-sm font-semibold text-muted hover:text-ink">← Paramètres</Link>
      <PageHeader title="Connecteurs" description="Ce qui est relié à votre CRM, ce qui fonctionne et où agir." />
      <ConnectorsView initial={connectors} />
    </div>
  );
}
