"use client";

// Points d'entrée du parcours : portail (contact connecté) et aperçu propriétaire (« Voir comme le client »).
// Rendu côté navigateur uniquement : le parcours lit les brouillons et les envois en cours gardés sur l'appareil.
import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { DiscoveryView } from "@/lib/discovery/types";
import { portalApi, previewApi } from "./flow-api";

const DiscoveryFlow = dynamic(() => import("./flow").then((m) => m.DiscoveryFlow), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#f7f4ff]" aria-busy="true">
      <span className="text-sm font-semibold text-violet-700">Chargement de ton onboarding…</span>
    </div>
  ),
});

export function PortalOnboarding({ initial }: { initial: DiscoveryView }) {
  const api = useMemo(() => portalApi(initial.project.id), [initial.project.id]);
  return <DiscoveryFlow initial={initial} api={api} exitHref={`/portail/p/${initial.project.id}`} />;
}

export function PreviewOnboarding({ initial }: { initial: DiscoveryView }) {
  const api = useMemo(() => previewApi(initial), [initial]);
  // l'aperçu démarre à l'accueil, comme un contact qui ouvre l'onboarding pour la première fois
  const view = useMemo(() => ({ ...initial, position: null, started_at: null, me: { id: "apercu", first_name: "Camille" } }), [initial]);
  return <DiscoveryFlow initial={view} api={api} exitHref={`/projets/${initial.project.id}/onboarding-decouverte`} />;
}
