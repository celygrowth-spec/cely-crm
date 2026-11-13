"use server";

// Menu « Actions » de la fiche : « Ajouter à une pipeline » et « Passer en client ».
import { after } from "next/server";
import { run } from "@/lib/action";
import { requireOwner } from "@/lib/auth";
import * as advance from "@/lib/crm/advance";
import * as sales from "@/lib/sales/service";

export async function addToPipelineAction(companyId: string, input: Parameters<typeof advance.addToPipeline>[2], key: string) {
  return run((sb) => advance.addToPipeline(sb, companyId, input, key));
}

/** Une transaction (étape, vente, revenu, projet, prochaine action) ; la préparation de l'onboarding suit en arrière-plan, comme après « Gagné ». */
export async function makeClientAction(companyId: string, input: Parameters<typeof advance.makeClient>[2], key: string) {
  const r = await run((sb) => advance.makeClient(sb, companyId, input, key));
  if (r.ok && r.data.project_id) {
    const projectId = r.data.project_id;
    after(async () => {
      const { supabase } = await requireOwner();
      await sales.prepareProject(supabase, projectId).catch((e) => console.error("préparation", e));
    });
  }
  return r;
}
