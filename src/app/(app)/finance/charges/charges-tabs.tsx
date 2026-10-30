"use client";

import { Tabs } from "@/components/ui";

export function ChargesTabs() {
  return <Tabs items={[{ href: "/finance/charges", label: "Charges", exact: true }, { href: "/finance/charges/abonnements", label: "Abonnements" }]} />;
}
