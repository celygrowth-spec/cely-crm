"use client";

import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui";
import { PROSPECTION_NAV } from "@/components/app-shell";

// Navigation de l'espace Prospection sur petit écran (sur desktop : dans la barre latérale)
export function ProspectionTabs() {
  const pathname = usePathname();
  if (pathname.startsWith("/prospection/focus")) return null;
  return (
    <div className="md:hidden">
      <Tabs items={PROSPECTION_NAV.map((n) => ({ href: n.href, label: n.label }))} />
    </div>
  );
}
