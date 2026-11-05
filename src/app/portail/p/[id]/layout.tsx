import { notFound, redirect } from "next/navigation";
import { PortalNav, PortalTopBar } from "@/components/portal/shell";
import { PortalSessionError, portalRpc } from "@/lib/projects/portal";
import type { PortalMe } from "@/lib/projects/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function PortalProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  let me: PortalMe;
  try {
    me = await portalRpc<PortalMe>("portal_me");
  } catch (e) {
    if (e instanceof PortalSessionError) redirect("/portail");
    throw e;
  }
  // la base revérifie à chaque appel ; ce contrôle évite seulement d'afficher la coque d'un projet non autorisé
  if (!me.projects.some((p) => p.id === id)) notFound();
  return (
    <>
      <PortalTopBar me={me} projectId={id} />
      <div className="mx-auto max-w-5xl px-4 pt-5 pb-24 md:pb-12">
        <PortalNav projectId={id} sections={["taches", "fichiers"]} />
        {children}
      </div>
    </>
  );
}
