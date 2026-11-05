"use client";

import { Tabs } from "@/components/ui";

export function ProjectTabs({ id }: { id: string }) {
  const base = `/projets/${id}`;
  return (
    <Tabs
      items={[
        { href: base, label: "Général", exact: true },
        { href: `${base}/acces`, label: "Accès client" },
      ]}
    />
  );
}
