"use client";
import { Tabs } from "@/components/ui";

export function MailTabs() {
  return <Tabs items={[{ href: "/mail", label: "Compte et envois", exact: true }, { href: "/mail/modeles", label: "Modèles d'email" }]} />;
}
