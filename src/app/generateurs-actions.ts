"use server";

// Réglages des générateurs (proposition, onboarding) : sélection par défaut de la bibliothèque.
import { run, type ActionResult } from "@/lib/action";
import { CrmError } from "@/lib/crm/service";
import type { GeneratorKind } from "@/lib/generators/rules";
import { setDefaultLibrary } from "@/lib/generators/service";

export async function setDefaultLibraryAction(kind: string, items: string[]): Promise<ActionResult<string[]>> {
  return run((sb) => {
    if (kind !== "proposal" && kind !== "onboarding") throw new CrmError("Générateur inconnu.");
    return setDefaultLibrary(sb, kind as GeneratorKind, Array.isArray(items) ? items : []);
  });
}
