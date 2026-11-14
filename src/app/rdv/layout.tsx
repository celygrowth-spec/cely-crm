import type { Metadata } from "next";
import { RdvShell } from "./rdv-shell";

// Pages publiques de réservation : aucune session, aucune donnée du CRM chargée ici.
export const metadata: Metadata = {
  title: "Prendre rendez-vous — Cely Growth",
  robots: { index: false, follow: false },
};

export default function RdvLayout({ children }: { children: React.ReactNode }) {
  return <RdvShell>{children}</RdvShell>;
}
