import Image from "next/image";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { decideAction } from "./actions";

// Écran de consentement du serveur OAuth 2.1 de Supabase (connexion de Claude au CRM).
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ authorization_id?: string }> }) {
  const { authorization_id } = await searchParams;
  if (!authorization_id) return <Shell><p className="text-sm text-danger">Requête d&apos;autorisation invalide.</p></Shell>;
  const { supabase, user } = await requireOwner();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorization_id);
  if (error || !data) return <Shell><p className="text-sm text-danger">Autorisation introuvable ou expirée : {error?.message}</p></Shell>;
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  const scopes = (data.scope ?? "").split(" ").filter(Boolean);
  return (
    <Shell>
      <h1 className="font-display text-xl font-extrabold">Autoriser {data.client.name ?? "cette application"} ?</h1>
      <p className="mt-2 text-sm text-muted">
        {data.client.name ?? "L'application"} pourra lire et modifier votre CRM avec votre compte ({user.email}) : rechercher des fiches, ajouter des
        notes, des personnes et des tâches, déplacer des fiches. Elle ne pourra ni fusionner, ni supprimer, ni envoyer de messages. Chaque écriture est journalisée.
      </p>
      <dl className="mt-4 space-y-1 text-xs text-muted">
        <div><dt className="inline font-semibold">Redirection : </dt><dd className="inline break-all">{data.redirect_uri}</dd></div>
        {scopes.length > 0 && <div><dt className="inline font-semibold">Portée : </dt><dd className="inline">{scopes.join(", ")}</dd></div>}
      </dl>
      <form action={decideAction} className="mt-6 flex gap-2">
        <input type="hidden" name="authorization_id" value={authorization_id} />
        <button name="decision" value="deny" className="h-9 flex-1 rounded-lg border border-line text-sm font-semibold hover:bg-surface">Refuser</button>
        <button name="decision" value="approve" className="h-9 flex-1 rounded-lg bg-ink text-sm font-semibold text-white hover:bg-violet-strong">Autoriser</button>
      </form>
      <p className="mt-4 text-xs text-muted">Vous pourrez révoquer cet accès depuis le tableau de bord Supabase (Authentication › OAuth Apps).</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-7 shadow-sm">
        <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={100} height={34} />
        <div className="mt-5">{children}</div>
      </div>
    </main>
  );
}
