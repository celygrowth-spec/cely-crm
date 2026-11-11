"use server";

// Suivi du temps : écritures réservées au propriétaire (contrôle complet, puis RLS). Le chrono
// démarre et s'arrête à l'heure du serveur (fonctions time_start / time_stop).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ActionResult } from "@/lib/action";
import { requireAppOwner } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { manualSlot, type TimeEntry } from "@/lib/time/calc";

type Running = TimeEntry & { now: string };
export type StartResult = { status: "started" | "running" | "conflict"; running: Running; stopped: Running | null }
  | { status: "confirm_end"; running: Running; suggested: string; stopped?: null };
/** confirm_end : chrono oublié (plus de 12 h) — l'heure de fin proposée est à confirmer (Q09). */
export type StopResult = { status: "stopped"; stopped: Running } | { status: "none" } | { status: "confirm_end"; running: Running; suggested: string };

async function owned<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<ActionResult<T>> {
  const { supabase } = await requireAppOwner();
  try {
    return { ok: true, data: await fn(supabase) };
  } catch (e) {
    if (e instanceof CrmError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Données invalides" };
    console.error("temps", e instanceof Error ? e.name : "erreur");
    return { ok: false, error: "L'action a échoué. Rechargez la page pour voir l'état, puis réessayez." };
  }
}
async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
const id = z.uuid("Identifiant invalide");
const label = z.string().trim().max(200, "200 caractères maximum").nullable().optional().transform((v) => (v ? v : null));
const iso = z.iso.datetime({ offset: true, message: "Date invalide" });
const DAY = 864e5;

export async function startTimerAction(companyId: string, text: string | null, switchRunning = false, projectId: string | null = null) {
  return owned((sb) => rpc<StartResult>(sb, "time_start", { p_company: id.parse(companyId), p_label: label.parse(text), p_switch: switchRunning, p_project: projectId ? id.parse(projectId) : null }));
}

/** `endedAt` : heure de fin confirmée d'un chrono oublié (sinon : maintenant). */
export async function stopTimerAction(endedAt: string | null = null) {
  return owned((sb) => rpc<StopResult>(sb, "time_stop", { p_ended_at: endedAt ? iso.parse(endedAt) : null }));
}

/** Projets actifs d'une fiche (choix facultatif d'un projet pour le temps passé, K09). */
export async function companyProjectsAction(companyId: string) {
  return owned(async (sb) => {
    const { data, error } = await sb.from("projects").select("id, name").eq("company_id", id.parse(companyId)).not("status", "in", "(termine,archive)").order("created_at", { ascending: false });
    if (error) throw new CrmError(friendlyError(error));
    return data as { id: string; name: string }[];
  });
}

const manual = z.object({
  company_id: id,
  project_id: id.nullable().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide"),
  ms: z.number().int().min(60_000, "Durée minimale : 1 minute").max(DAY, "24 heures maximum par saisie"),
  label,
});
export async function addTimeAction(input: z.input<typeof manual>) {
  return owned(async (sb) => {
    const m = manual.parse(input);
    const slot = manualSlot(m.day, m.ms);
    const { data, error } = await sb.from("time_entries").insert({ company_id: m.company_id, project_id: m.project_id ?? null, label: m.label, source: "manual", ...slot }).select("id").single();
    if (error) throw new CrmError(friendlyError(error));
    return data as { id: string };
  });
}

const edit = z.object({ company_id: id, project_id: id.nullable().optional(), label, started_at: iso, ended_at: iso.nullable() })
  .refine((e) => !e.ended_at || Date.parse(e.ended_at) > Date.parse(e.started_at), { message: "La fin doit être après le début" })
  .refine((e) => !e.ended_at || Date.parse(e.ended_at) - Date.parse(e.started_at) <= 7 * DAY, { message: "7 jours maximum pour une session" })
  .refine((e) => Date.parse(e.started_at) <= Date.now() + 60_000, { message: "Le début ne peut pas être dans le futur" });
export async function updateTimeAction(entryId: string, input: z.input<typeof edit>) {
  return owned(async (sb) => {
    const e = edit.parse(input);
    const { data: cur } = await sb.from("time_entries").select("ended_at").eq("id", id.parse(entryId)).maybeSingle();
    if (!cur) throw new CrmError("Session introuvable");
    // chrono en cours : la fin reste ouverte (on l'arrête avec « Arrêter »)
    const patch = cur.ended_at === null ? { company_id: e.company_id, project_id: e.project_id ?? null, label: e.label, started_at: e.started_at } : { ...e, project_id: e.project_id ?? null };
    const { error } = await sb.from("time_entries").update(patch).eq("id", entryId);
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function deleteTimeAction(entryId: string) {
  return owned(async (sb) => {
    const { error, count } = await sb.from("time_entries").delete({ count: "exact" }).eq("id", id.parse(entryId));
    if (error) throw new CrmError(friendlyError(error));
    if (!count) throw new CrmError("Session introuvable");
  });
}
