import "server-only";
// Déclenchement de la tâche Claude Code du diagnostic (point d'entrée « /fire », abonnement Claude).
// Le jeton ne quitte jamais le serveur et n'apparaît dans aucun message d'erreur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "./service";

const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;

export function routineConfig() {
  const url = process.env.DIAGNOSTIC_ROUTINE_URL?.trim();
  const token = process.env.DIAGNOSTIC_ROUTINE_TOKEN?.trim();
  return url && token && FIRE_URL.test(url) ? { url, token } : null;
}

/** Démarre une session de la tâche avec l'identifiant du dossier pour seul texte. */
export async function fireRoutine(dossierId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const cfg = routineConfig();
  if (!cfg) throw new CrmError("Déclenchement automatique non configuré : utilisez le lien vers Claude.");
  let res: Response;
  try {
    res = await fetcher(cfg.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "anthropic-version": "2026-10-21", "content-type": "application/json" },
      body: JSON.stringify({ text: dossierId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CrmError("Claude n'a pas pu être joint. Réessayez ou utilisez le lien.");
  }
  if (res.status === 401 || res.status === 404) throw new CrmError("Jeton ou adresse de la tâche Claude refusés : vérifiez la configuration.");
  if (res.status === 429) throw new CrmError("Trop de lancements cette heure-ci : réessayez plus tard.");
  if (!res.ok) throw new CrmError(`Claude a refusé le lancement (code ${res.status}).`);
  const body = (await res.json().catch(() => null)) as { claude_code_session_url?: unknown } | null;
  const url = typeof body?.claude_code_session_url === "string" ? body.claude_code_session_url : null;
  return url && /^https:\/\/claude\.ai\//.test(url) ? url : null;
}

export type TriggerOutcome = { triggered: boolean; error?: string };

/** Une étape d'un dossier ne lance qu'une session ; un échec la rend relançable. */
export async function triggerDiagnostic(sb: SupabaseClient, id: string, stage: "start" | "answers", fetcher?: typeof fetch): Promise<TriggerOutcome> {
  if (!routineConfig()) return { triggered: false };
  const claim = await sb.rpc("diagnostic_claim_trigger", { p_id: z.uuid().parse(id), p_stage: stage });
  if (claim.error) throw new CrmError(friendlyError(claim.error));
  if (claim.data !== true) return { triggered: false };
  try {
    const url = await fireRoutine(id, fetcher);
    await sb.rpc("diagnostic_trigger_result", { p_id: id, p_session_url: url, p_error: null });
    return { triggered: true };
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Lancement impossible.";
    await sb.rpc("diagnostic_trigger_result", { p_id: id, p_session_url: null, p_error: message });
    return { triggered: false, error: message };
  }
}
