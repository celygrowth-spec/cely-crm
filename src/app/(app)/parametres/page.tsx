import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { signOutAction } from "@/app/actions";
import { SourcesManager } from "./sources-manager";

export default async function ParametresPage() {
  const { supabase, user } = await requireOwner();
  const { data: sources } = await supabase.from("lead_sources").select("id, name, position, color, archived_at, companies(count)").order("position").order("name");

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Paramètres" />
      <Link href="/parametres/connecteurs" className="block rounded-2xl border border-line bg-white p-4 hover:border-violet" data-connecteurs-link>
        <h2 className="font-display text-base font-bold">Connecteurs</h2>
        <p className="mt-1 text-sm text-muted">Gmail, Google Agenda et Meet, Fireflies, Claude (MCP) : ce qui est connecté, ce qui demande une action, et où agir. L&apos;adresse du serveur MCP et les accès accordés à Claude s&apos;y trouvent.</p>
        <span className="mt-2 inline-block text-sm font-semibold text-violet-strong">Ouvrir les connecteurs →</span>
      </Link>


      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Sources du contact</h2>
        <p className="mb-3 text-sm text-muted">Origine d&apos;acquisition de la fiche, distincte du canal d&apos;un message, d&apos;une liste ou d&apos;une campagne. Renommer met à jour partout ; archiver masque des nouveaux choix sans toucher aux fiches.</p>
        <SourcesManager
          sources={(sources ?? []).map(({ companies, ...s }) => ({ ...s, used: (companies as unknown as { count: number }[])[0]?.count ?? 0 })) as never}
        />
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Données</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li><Link className="font-semibold text-violet-strong" href="/parametres/diagnostic">Bibliothèque de diagnostic (prompt et exemples)</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/pipelines">Gérer les pipelines et leurs étapes</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/doublons">Doublons à vérifier</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/base?archived=1">Fiches archivées</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/import">Importer / exporter en CSV</Link></li>
        </ul>
      </Card>

      <Card className="flex items-center justify-between p-4">
        <div>
          <h2 className="font-display text-base font-bold">Compte</h2>
          <p className="text-sm text-muted">{user.email}</p>
        </div>
        <form action={signOutAction}><button className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:bg-surface">Se déconnecter</button></form>
      </Card>
    </div>
  );
}
