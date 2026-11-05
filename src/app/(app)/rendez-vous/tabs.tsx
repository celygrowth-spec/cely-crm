"use client";

import { Tabs } from "@/components/ui";
import { RDV_NAV } from "@/components/app-shell";

// Navigation de l'espace Rendez-vous sur petit écran (sur desktop : dans la barre latérale)
export function RdvTabs() {
  return (
    <div className="md:hidden">
      <Tabs items={RDV_NAV} />
    </div>
  );
}
