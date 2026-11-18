import { CompanyRecord } from "@/components/company-record";
import { requireOwner } from "@/lib/auth";

const TABS = { diagnostic: "diagnostic", proposition: "proposal" } as const;

export default async function FichePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ onglet?: string; lancer?: string }> }) {
  await requireOwner();
  const { id } = await params;
  // ?onglet=proposition : lien direct depuis le Pipeline, Appels ou Aujourd'hui
  const sp = await searchParams;
  const tab = TABS[sp.onglet as keyof typeof TABS];
  return (
    <div className="mx-auto max-w-4xl">
      <CompanyRecord key={id} id={id} page initialTab={tab} autoStart={sp.lancer === "1"} />
    </div>
  );
}
