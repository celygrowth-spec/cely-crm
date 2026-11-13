"use client";

import { Tabs } from "@/components/ui";
import { PRODUCTIVITE_NAV } from "@/components/app-shell";

// Navigation de l'espace Productivité sur petit écran (sur desktop : dans la barre latérale)
export function ProductiviteTabs() {
  return (
    <div className="md:hidden">
      <Tabs items={PRODUCTIVITE_NAV} />
    </div>
  );
}
