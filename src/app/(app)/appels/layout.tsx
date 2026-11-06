import { Tabs } from "@/components/ui";
import { requireOwner } from "@/lib/auth";

const NAV = [
  { href: "/appels", label: "Appels à rattacher", exact: true },
  { href: "/appels/suivi", label: "Suivi Fireflies" },
];

export default async function AppelsLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return (
    <div>
      <Tabs items={NAV} />
      {children}
    </div>
  );
}
