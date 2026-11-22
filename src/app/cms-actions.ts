"use server";

// CMS : écritures réservées au propriétaire (contrôle complet, puis RLS et fonctions en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireAppOwner } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";
import { PastDateError, createEntry, existingSlugs, importEntry, publishNow, schedule, setStatus, updateEntry, type DraftInput, type ImportItem } from "@/lib/cms/service";
import { confirmMediaUpload, deleteMedia, mediaUsage, startMediaUpload } from "@/lib/cms/media";
import type { CmsEntry } from "@/lib/cms/types";
import { flushRevalidations } from "@/lib/cms/revalidate";
import { createPreview, revokePreviews } from "@/lib/cms/preview";
import { deletePage, importPages, savePage, type PageInput } from "@/lib/cms/pages-service";

export type CmsResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: "past_date" };

async function owned<T>(fn: (sb: SupabaseClient) => Promise<T>, refreshSite = false): Promise<CmsResult<T>> {
  const { supabase } = await requireAppOwner();
  try {
    const data = await fn(supabase);
    // ce qui change sur le site est demandé aussitôt au site ; un échec reste en base et sera repris
    if (refreshSite) await flushRevalidations(supabase).catch(() => undefined);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof PastDateError) return { ok: false, error: e.message, code: "past_date" };
    if (e instanceof CrmError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Données invalides" };
    console.error("cms", e instanceof Error ? e.name : "erreur");
    return { ok: false, error: "L'enregistrement a échoué. Votre saisie est conservée : réessayez." };
  }
}

export async function createEntryAction(id: string, input: DraftInput & { title: string }) {
  return owned<CmsEntry>((sb) => createEntry(sb, id, input));
}

export async function updateEntryAction(id: string, patch: DraftInput) {
  return owned<CmsEntry>((sb) => updateEntry(sb, id, patch), true);
}

export async function publishNowAction(id: string) {
  return owned(async (sb) => (await publishNow(sb, id)).entry, true);
}

export async function scheduleAction(id: string, at: string, confirmNow = false) {
  return owned(async (sb) => (await schedule(sb, id, at, confirmNow)).entry, true);
}

export async function setStatusAction(id: string, status: "draft" | "unpublished") {
  return owned(async (sb) => (await setStatus(sb, id, status)).entry, true);
}

// --- Images ---
export async function startMediaUploadAction(input: { name: string; size: number }) {
  return owned((sb) => startMediaUpload(sb, input));
}

export async function confirmMediaUploadAction(id: string) {
  return owned((sb) => confirmMediaUpload(sb, id));
}

export async function mediaUsageAction(path: string) {
  return owned((sb) => mediaUsage(sb, path));
}

export async function deleteMediaAction(id: string, confirmed: boolean) {
  return owned((sb) => deleteMedia(sb, id, confirmed));
}

// --- Import ---
export async function existingSlugsAction(slugs: string[]) {
  return owned((sb) => existingSlugs(sb, slugs));
}

export async function importEntryAction(item: ImportItem) {
  return owned((sb) => importEntry(sb, item), true);
}

// --- Pages SEO ---
export async function savePageAction(id: string | null, input: PageInput) {
  return owned((sb) => savePage(sb, id, input), true);
}

export async function deletePageAction(id: string) {
  return owned((sb) => deletePage(sb, id), true);
}

export async function importPagesAction(text: string) {
  if (text.length > 1_000_000) return { ok: false as const, error: "Fichier trop volumineux (1 Mo au plus)." };
  return owned((sb) => importPages(sb, text), true);
}

// --- Publication ---
export async function previewAction(id: string, hours = 24) {
  return owned((sb) => createPreview(sb, id, hours));
}

export async function revokePreviewsAction(id: string) {
  return owned((sb) => revokePreviews(sb, id));
}

/** « Réessayer » : les rafraîchissements en échec sont renvoyés tout de suite. */
export async function retryRefreshAction() {
  return owned(async (sb) => {
    const { error } = await sb.rpc("cms_revalidation_retry");
    if (error) throw new CrmError("Relance impossible.");
    return flushRevalidations(sb);
  });
}
