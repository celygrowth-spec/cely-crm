import Link from "next/link";
import { headers } from "next/headers";
import { Card, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { signOutAction } from "@/app/actions";
import { SourcesManager } from "./sources-manager";

export default async function ParametresPage() {
  const { supabase, user } = await requireOwner();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const mcpUrl = `${proto}://${host}/api/mcp`;
  const [{ data: sources }, { data: log }] = await Promise.all([
    supabase.from("lead_sources").select("id, name, position").order("position").order("name"),
    supabase.from("activity_log").select("id, table_name, operation, created_at, company_id").order("created_at", { ascending: false }).limit(10),
  ]);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Paramètres" />

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Sources du lead</h2>
        <p className="mb-3 text-sm text-muted">Liste proposée sur chaque fiche. Supprimer une source vide ce champ sur les fiches concernées, sans les supprimer.</p>
        <SourcesManager sources={sources ?? []} />
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Données</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li><Link className="font-semibold text-violet-strong" href="/pipelines">Gérer les pipelines et leurs étapes</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/doublons">Doublons à vérifier</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/base?archived=1">Fiches archivées</Link></li>
          <li><Link className="font-semibold text-violet-strong" href="/prospection/import">Importer / exporter en CSV</Link></li>
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Connexion à Claude</h2>
        <p className="mt-1 text-sm text-muted">
          Ajoutez ce CRM comme connecteur personnalisé dans Claude. L&apos;authentification passe par votre compte (OAuth Supabase) : Claude n&apos;obtient
          que vos propres droits, ne peut ni fusionner ni supprimer, et chacune de ses écritures est journalisée.
        </p>
        <p className="mt-3 font-label text-xs font-semibold text-muted">URL du serveur MCP</p>
        <code className="mt-1 block rounded-lg bg-surface px-3 py-2 text-sm break-all">{mcpUrl}</code>
        <p className="mt-2 text-xs text-muted">Étapes de configuration détaillées dans le README (section « Connexion à Claude »).</p>
        {!!log?.length && (
          <>
            <p className="mt-4 font-label text-xs font-semibold text-muted">Dernières écritures de Claude</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {log.map((l) => <li key={l.id}>{formatDateTime(l.created_at)} · {l.operation} {l.table_name}</li>)}
            </ul>
          </>
        )}
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
