"use client";

import { Tabs } from "@/components/ui";

export function ProspectionTabs() {
  return (
    <Tabs
      items={[
        { href: "/prospection", label: "Base", exact: true },
        { href: "/prospection/listes", label: "Listes" },
        { href: "/prospection/campagnes", label: "Campagnes" },
        { href: "/prospection/modeles", label: "Modèles" },
        { href: "/prospection/doublons", label: "Doublons" },
        { href: "/prospection/import", label: "Import / export" },
      ]}
    />
  );
}
