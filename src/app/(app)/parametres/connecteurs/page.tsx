// Paramètres › Connecteurs : ce qui est relié au CRM, en un coup d'œil. États lus en base à
// l'ouverture (aucun appel aux fournisseurs) ; chaque service se vérifie ensuite à la demande.
// Deux vues : la liste (réglages) et la carte (mêmes états, vus comme un schéma).
import { headers } from "next/headers";
import Link from "next/link";
import { LemlistAccounts } from "@/components/lemlist/lemlist-accounts";
import { PageHeader } from "@/components/ui";
import { requireAppOwner } from "@/lib/auth";
import { loadMapInput } from "@/lib/connectors/map";
import { loadConnectors } from "@/lib/connectors/status";
import { ConnectorsMap } from "./connectors-map";
import { ConnectorsView } from "./connectors-view";

export const dynamic = "force-dynamic";

export default async function ConnecteursPage({ searchParams }: { searchParams: Promise<{ vue?: string; gerer?: string }> }) {
  const { supabase } = await requireAppOwner();
  const { vue, gerer } = await searchParams;
  const map = vue === "carte";
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const connectors = await loadConnectors(supabase, `${proto}://${host}/api/mcp`);
  const mapInput = map ? await loadMapInput(supabase, connectors) : null;
  const tab = (active: boolean) =>
    `-mb-px border-b-2 px-3 py-2 font-label text-sm font-semibold whitespace-nowrap ${active ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink"}`;
  return (
    <div className={map ? "max-w-6xl" : "max-w-3xl"}>
      <Link href="/parametres" className="text-sm font-semibold text-muted hover:text-ink">← Paramètres</Link>
      <PageHeader title="Connecteurs" description="Ce qui est relié à votre CRM, ce qui fonctionne et où agir." />
      <nav className="mb-5 flex gap-1 border-b border-line" aria-label="Vues des connecteurs">
        <Link href="/parametres/connecteurs" className={tab(!map)} aria-current={!map ? "page" : undefined}>Liste</Link>
        <Link href="/parametres/connecteurs?vue=carte" className={tab(map)} aria-current={map ? "page" : undefined}>Carte</Link>
      </nav>
      {mapInput ? (
        <ConnectorsMap initial={mapInput} />
      ) : (
        <>
          <ConnectorsView initial={connectors} initialOpen={gerer ?? null} />
          <div id="lemlist" className="scroll-mt-6"><LemlistAccounts /></div>
        </>
      )}
    </div>
  );
}
