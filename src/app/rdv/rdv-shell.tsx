"use client";

import { useSelectedLayoutSegments } from "next/navigation";
import { EMBED_PATH } from "@/lib/appointments/embed";

// Habillage des pages publiques. La version intégrée (/rdv/<lien>/integre) s'affiche sans marges ni fond :
// c'est le site qui l'accueille qui fournit l'espace autour.
export function RdvShell({ children }: { children: React.ReactNode }) {
  const segments = useSelectedLayoutSegments();
  if (segments.length === 2 && segments[0] !== "gerer" && segments[1] === EMBED_PATH) return <>{children}</>;
  return (
    <div className="min-h-dvh bg-surface px-3 py-6 sm:px-6 md:py-12">
      <div className="mx-auto max-w-5xl">{children}</div>
      <p className="mt-6 text-center font-label text-[11px] text-muted">Cely Growth · réservation sécurisée</p>
    </div>
  );
}
