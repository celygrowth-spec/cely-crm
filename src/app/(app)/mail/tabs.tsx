"use client";
import { Tabs } from "@/components/ui";

export function MailTabs() {
  return <Tabs items={[{ href: "/mail/boite", label: "Boîte" }, { href: "/mail", label: "Compte et envois", exact: true }, { href: "/mail/modeles", label: "Modèles d'email" }]} />;
}
