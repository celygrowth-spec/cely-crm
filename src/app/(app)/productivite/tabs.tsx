"use client";

import { Tabs } from "@/components/ui";
import { PRODUCTIVITE_NAV } from "@/components/app-shell";

// Navigation de l'espace Productivité (onglets de la page, sur ordinateur comme sur téléphone)
export function ProductiviteTabs() {
  return (
    <div>
      <Tabs items={PRODUCTIVITE_NAV} />
    </div>
  );
}
