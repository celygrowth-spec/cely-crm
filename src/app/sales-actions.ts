"use server";

import { after } from "next/server";
import { run } from "@/lib/action";
import { requireOwner } from "@/lib/auth";
import type { SaleStage } from "@/lib/sales/rules";
import * as sales from "@/lib/sales/service";

/** Prépare le projet après la réponse : l'interface rend la main tout de suite. */
function prepareLater(saleId: string) {
  after(async () => {
    const { supabase } = await requireOwner();
    await sales.prepareSale(supabase, saleId);
  });
}

export async function saleContextAction(companyId: string) {
  return run((sb) => sales.saleContext(sb, companyId));
}

/** « Confirmer la vente » : une transaction, rejouable avec la même clé ; la préparation suit en arrière-plan. */
export async function confirmSaleAction(companyId: string, input: sales.ConfirmInput, key: string) {
  const r = await run((sb) => sales.confirmSale(sb, companyId, input, key));
  if (r.ok) prepareLater(r.data.sale_id);
  return r;
}

export async function setSaleStageAction(saleId: string, stage: SaleStage) {
  return run((sb) => sales.setSaleStage(sb, saleId, stage));
}

/** Reprendre la préparation (échec, ou éléments complétés depuis). */
export async function retryPrepAction(saleId: string) {
  return run(async (sb) => {
    await sales.prepareSale(sb, saleId);
    return true;
  });
}
