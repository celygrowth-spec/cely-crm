import type { Metadata } from "next";

// Pages publiques de réservation : aucune session, aucune donnée du CRM chargée ici.
export const metadata: Metadata = {
  title: "Prendre rendez-vous — Cely Growth",
  robots: { index: false, follow: false },
};

export default function RdvLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface px-3 py-6 sm:px-6 md:py-12">
      <div className="mx-auto max-w-5xl">{children}</div>
      <p className="mt-6 text-center font-label text-[11px] text-muted">Cely Growth · réservation sécurisée</p>
    </div>
  );
}
