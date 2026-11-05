"use client";

import { Tabs } from "@/components/ui";

export function ProjectTabs({ id }: { id: string }) {
  const base = `/projets/${id}`;
  return (
    <Tabs
      items={[
        { href: base, label: "Général", exact: true },
        { href: `${base}/planning`, label: "Planning" },
        { href: `${base}/points`, label: "Points" },
        { href: `${base}/taches`, label: "Tâches" },
        { href: `${base}/fichiers`, label: "Fichiers" },
        { href: `${base}/acces`, label: "Accès client" },
      ]}
    />
  );
}
