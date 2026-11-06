"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { ExpenseModal } from "@/components/finance/forms";
import { RevenueModal } from "@/components/finance/revenue-forms";
import { settingsAt } from "@/lib/finance/calc";
import type { FinanceData } from "@/lib/finance/types";

/** « Ajouter un revenu » (action principale) et « Ajouter une charge », depuis l'accueil Finance. */
export function QuickAdd({ data, only }: { data: FinanceData; only?: "revenu" }) {
  const router = useRouter();
  const [open, setOpen] = useState<"revenu" | "charge" | null>(null);
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const clients = [...new Map(
    [...data.missions.filter((m) => m.status !== "termine").map((m) => ({ id: m.company_id, name: m.company_name })), ...data.invoices.map((i) => ({ id: i.company_id, name: i.company_name }))]
      .map((c) => [c.id, c]),
  ).values()].slice(0, 8);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen("revenu")}><Plus size={15} /> Ajouter un revenu</Button>
      {!only && <Button onClick={() => setOpen("charge")}><Plus size={15} /> Ajouter une charge</Button>}
      <RevenueModal open={open === "revenu"} onClose={() => setOpen(null)} clients={clients} vatEnabled={vat} onSaved={(id) => router.push(`/finance/revenus?revenu=${id}`)} />
      {!only && <ExpenseModal open={open === "charge"} onClose={() => setOpen(null)} defaults={{}} categories={data.categories} vatEnabled={vat} />}
    </>
  );
}
