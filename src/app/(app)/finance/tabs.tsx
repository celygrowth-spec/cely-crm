"use client";

import { Tabs } from "@/components/ui";
import { FINANCE_NAV } from "@/components/app-shell";

// Navigation de l'espace Finance (onglets de la page, sur ordinateur comme sur téléphone)
export function FinanceTabs() {
  return (
    <div>
      <Tabs items={FINANCE_NAV} />
    </div>
  );
}
