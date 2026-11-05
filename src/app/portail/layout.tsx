import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Espace client — Cely Growth",
  robots: { index: false, follow: false },
};

// Portail client : aucune donnée du CRM n'est chargée ici, uniquement le contenu publié via portal_*.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-surface">{children}</div>;
}
