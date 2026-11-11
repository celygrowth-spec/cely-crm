"use server";

import { after } from "next/server";
import { run } from "@/lib/action";
import { requireOwner } from "@/lib/auth";
import type { SaleStage } from "@/lib/sales/rules";
import * as sales from "@/lib/sales/service";

/** Prépare le projet après la réponse (une seule source : l'onboarding de Projets) ; l'interface rend la main. */
function prepareLater(projectId: string) {
  after(async () => {
    const { supabase } = await requireOwner();
    await sales.prepareProject(supabase, projectId).catch((e) => console.error("préparation", e));
  });
}

export async function saleContextAction(companyId: string) {
  return run((sb) => sales.saleContext(sb, companyId));
}

/** « Confirmer la vente » : une transaction, rejouable avec la même clé ; la préparation suit en arrière-plan. */
export async function confirmSaleAction(companyId: string, input: sales.ConfirmInput, key: string) {
  const r = await run((sb) => sales.confirmSale(sb, companyId, input, key));
  if (r.ok && r.data.project_id) prepareLater(r.data.project_id);
  return r;
}

export async function setSaleStageAction(saleId: string, stage: SaleStage, confirm = false) {
  return run((sb) => sales.setSaleStage(sb, saleId, stage, confirm));
}

/** Reprendre la préparation (échec, ou éléments complétés depuis) ; corrections manuelles conservées. */
export async function retryPrepAction(projectId: string) {
  return run(async (sb) => {
    await sales.prepareProject(sb, projectId);
    return true;
  });
}

export async function dealLinksAction(companyId: string) {
  return run((sb) => sales.dealLinks(sb, companyId));
}

/** Rouvrir ou perdre avec les décisions sur le projet, le revenu et les accès client (une opération). */
export async function dealTransitionAction(companyId: string, status: "open" | "lost", options: sales.TransitionOptions, key: string) {
  return run((sb) => sales.dealTransition(sb, companyId, status, options, key));
}

/** Client qui revient : nouvelle opportunité sur la même fiche (la vente actuelle reste dans Ventes). */
export async function newOpportunityAction(companyId: string, stageId: string, key: string) {
  return run((sb) => sales.newOpportunity(sb, companyId, stageId, key));
}
