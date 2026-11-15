"use client";

import { Tabs } from "@/components/ui";
import { RDV_NAV } from "@/components/app-shell";

// Navigation de l'espace Rendez-vous (onglets de la page, sur ordinateur comme sur téléphone)
export function RdvTabs() {
  return (
    <div>
      <Tabs items={RDV_NAV} />
    </div>
  );
}
