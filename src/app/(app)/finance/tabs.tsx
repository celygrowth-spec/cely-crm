"use client";

import { Tabs } from "@/components/ui";
import { FINANCE_NAV } from "@/components/app-shell";

// Navigation de l'espace Finance sur petit écran (sur desktop : dans la barre latérale)
export function FinanceTabs() {
  return (
    <div className="md:hidden">
      <Tabs items={FINANCE_NAV} />
    </div>
  );
}
