import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PortalOnboarding } from "@/components/discovery/flow-hosts";
import { PortalError, PortalSessionError, portalRpc } from "@/lib/projects/portal";
import type { DiscoveryView } from "@/lib/discovery/types";

export const metadata: Metadata = { title: "Onboarding · Offre découverte" };

// Plein écran (le parcours recouvre la barre du portail). Visible seulement si « Offre découverte » est cochée :
// sinon la base répond « introuvable », comme pour le projet d'un autre client.
export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let view: DiscoveryView;
  try {
    view = await portalRpc<DiscoveryView>("portal_discovery", { p_project: id });
  } catch (e) {
    if (e instanceof PortalSessionError) redirect("/portail");
    if (e instanceof PortalError && e.code === "not_found") notFound();
    throw e;
  }
  return <PortalOnboarding initial={view} />;
}
