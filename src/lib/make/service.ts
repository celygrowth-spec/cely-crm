import "server-only";
// Connecteur Make, côté serveur : scénarios (adresse chiffrée), appels sortants, journal.
// L'adresse d'un webhook est déchiffrée ici seulement, le temps de l'appel : elle n'est jamais renvoyée au
// navigateur, ni écrite dans un message d'erreur, un log ou le journal.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { appUrl, appointmentsSecretOrNull } from "@/lib/appointments/config";
import { decryptSecret, encryptSecret } from "@/lib/appointments/secrets";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { scenarioKey, webhookAllowed, type MakeCall, type MakeDetail, type MakeScenario } from "./rules";

const uuid = z.uuid("Identifiant invalide");
const SERVER_MISSING = "Secret serveur absent (APPOINTMENTS_SECRET) : l'adresse du webhook ne peut pas être protégée.";

/** Secret partagé avec Make pour la route de retour (`Authorization: Bearer …`). */
export function makeCallbackSecret(): string | null {
  const s = process.env.MAKE_CALLBACK_SECRET?.trim();
  return s && s.length >= 24 ? s : null;
}

/** Origine acceptée en plus de Make, pour la recette (faux serveur local ou webhook de test). */
const testOrigin = () => process.env.MAKE_TEST_WEBHOOK_ORIGIN ?? null;

export function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const callbackUrl = (origin?: string | null) => `${appUrl(origin)}/api/make/retour`;

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

export async function listScenarios(sb: SupabaseClient): Promise<MakeScenario[]> {
  return check<MakeScenario[]>(await sb.from("make_scenarios").select("id, key, name, updated_at").order("created_at"));
}

export async function listCalls(sb: SupabaseClient, limit = 20): Promise<MakeCall[]> {
  return check<MakeCall[]>(await sb.from("make_calls").select("id, at, direction, scenario, event, status, error").order("id", { ascending: false }).limit(limit));
}

export async function makeDetail(sb: SupabaseClient, origin?: string | null): Promise<MakeDetail> {
  const [scenarios, calls] = await Promise.all([listScenarios(sb), listCalls(sb)]);
  return { scenarios, calls, callbackUrl: callbackUrl(origin), secretPresent: !!makeCallbackSecret(), serverReady: !!appointmentsSecretOrNull() };
}

const nameSchema = z.string().trim().min(1, "Donnez un nom au scénario.").max(80, "Nom trop long (80 caractères au plus).");

function encryptWebhook(url: string): string {
  const value = url.trim();
  if (!webhookAllowed(value, testOrigin())) throw new CrmError("Cette adresse n'est pas celle d'un webhook Make (https://hook.….make.com/…).");
  if (!appointmentsSecretOrNull()) throw new CrmError(SERVER_MISSING);
  return encryptSecret(value);
}

/** Crée un scénario (nom et adresse), ou le modifie : l'adresse n'est remplacée que si une nouvelle est fournie. */
export async function saveScenario(sb: SupabaseClient, input: { id?: string | null; name: string; url?: string | null }): Promise<MakeScenario> {
  const name = nameSchema.parse(input.name);
  const url = input.url?.trim() || null;
  if (input.id) {
    const patch = { name, ...(url ? { webhook_enc: encryptWebhook(url) } : {}) };
    const row = check<MakeScenario | null>(await sb.from("make_scenarios").update(patch).eq("id", uuid.parse(input.id)).select("id, key, name, updated_at").maybeSingle());
    if (!row) throw new CrmError("Scénario introuvable.");
    return row;
  }
  if (!url) throw new CrmError("Collez l'adresse du webhook du scénario.");
  const key = scenarioKey(name);
  if (key.length < 2) throw new CrmError("Ce nom ne contient pas assez de lettres ou de chiffres.");
  const res = await sb.from("make_scenarios").insert({ key, name, webhook_enc: encryptWebhook(url) }).select("id, key, name, updated_at").single();
  if (res.error?.code === "23505") throw new CrmError("Un scénario porte déjà ce nom.");
  return check<MakeScenario>(res);
}

export async function deleteScenario(sb: SupabaseClient, id: string): Promise<void> {
  const gone = check<unknown[]>(await sb.from("make_scenarios").delete().eq("id", uuid.parse(id)).select("id"));
  if (!gone.length) throw new CrmError("Scénario introuvable.");
}

export type MakeOutcome = { ok: true } | { ok: false; error: string };

/** Enveloppe commune à tous les appels : un scénario filtre sur `event` et s'arrête si `test` est vrai. */
export function envelope(event: string, requestId: string, data: Record<string, unknown>, test: boolean, origin?: string | null) {
  return { event, test, request_id: requestId, sent_at: new Date().toISOString(), callback_url: callbackUrl(origin), ...data };
}

async function post(url: string, body: unknown, fetcher: typeof fetch): Promise<MakeOutcome> {
  let res: Response;
  try {
    res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "Make n'a pas répondu à temps." : "Make est injoignable." };
  }
  if (res.status === 404 || res.status === 410) return { ok: false, error: "Webhook introuvable chez Make : vérifiez l'adresse du scénario, et qu'il est actif." };
  if (res.status === 429) return { ok: false, error: "Make limite les appels pour le moment : réessayez plus tard." };
  if (!res.ok) return { ok: false, error: `Make a refusé l'appel (code ${res.status}).` };
  return { ok: true };
}

/**
 * Appelle un scénario par son identifiant stable et note le résultat au journal (jamais le contenu).
 * Ne lève pas d'erreur pour un échec de Make : l'appelant décide quoi relancer.
 */
export async function callScenario(
  sb: SupabaseClient, key: string, event: string, requestId: string, data: Record<string, unknown>,
  opts: { test?: boolean; fetcher?: typeof fetch; origin?: string | null } = {},
): Promise<MakeOutcome> {
  const row = check<{ name: string; webhook_enc: string } | null>(await sb.from("make_scenarios").select("name, webhook_enc").eq("key", key).maybeSingle());
  if (!row) return { ok: false, error: "Scénario Make non configuré : ajoutez-le dans Paramètres › Connecteurs › Make." };
  let outcome: MakeOutcome;
  try {
    const url = decryptSecret(row.webhook_enc);
    outcome = webhookAllowed(url, testOrigin())
      ? await post(url, envelope(event, requestId, data, !!opts.test, opts.origin), opts.fetcher ?? fetch)
      : { ok: false, error: "Adresse du webhook refusée : enregistrez-la de nouveau." };
  } catch {
    outcome = { ok: false, error: "Adresse du webhook illisible (secret serveur modifié ?) : enregistrez-la de nouveau." };
  }
  check(await sb.rpc("make_log_call", { p_scenario: row.name, p_event: event, p_ok: outcome.ok, p_error: outcome.ok ? null : outcome.error }));
  return outcome;
}

/** « Tester la connexion » : un appel marqué comme test, sans aucune donnée de client. */
export async function testScenario(sb: SupabaseClient, id: string, opts: { fetcher?: typeof fetch; origin?: string | null } = {}): Promise<MakeOutcome> {
  const row = check<{ key: string } | null>(await sb.from("make_scenarios").select("key").eq("id", uuid.parse(id)).maybeSingle());
  if (!row) throw new CrmError("Scénario introuvable.");
  return callScenario(sb, row.key, "test", randomUUID(), {}, { ...opts, test: true });
}
