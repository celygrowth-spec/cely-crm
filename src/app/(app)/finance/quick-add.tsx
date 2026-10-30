"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { ExpenseModal, InvoiceModal } from "@/components/finance/forms";
import { settingsAt } from "@/lib/finance/calc";
import type { FinanceData } from "@/lib/finance/types";

/** Boutons « Ajouter un revenu » / « Ajouter une charge » disponibles depuis la vue d'ensemble. */
export function QuickAdd({ data }: { data: FinanceData }) {
  const [open, setOpen] = useState<"revenu" | "charge" | null>(null);
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const clients = [...new Map(data.missions.filter((m) => m.status !== "termine").map((m) => [m.company_id, { id: m.company_id, name: m.company_name }])).values()];
  return (
    <>
      <Button variant="primary" onClick={() => setOpen("revenu")}><Plus size={15} /> Ajouter un revenu</Button>
      <Button onClick={() => setOpen("charge")}><Plus size={15} /> Ajouter une charge</Button>
      <InvoiceModal open={open === "revenu"} onClose={() => setOpen(null)} defaults={{}} missions={data.missions} vatEnabled={vat} clients={clients} />
      <ExpenseModal open={open === "charge"} onClose={() => setOpen(null)} defaults={{}} categories={data.categories} vatEnabled={vat} />
    </>
  );
}
