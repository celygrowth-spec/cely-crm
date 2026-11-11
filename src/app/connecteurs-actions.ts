"use server";

// Actions de l'espace Connecteurs. Elles réutilisent les fonctions de chaque module (OAuth, jetons,
// révocation) : aucune seconde intégration. Réservées au propriétaire (contrôle complet, puis RLS).
// Les messages renvoyés sont les nôtres : jamais de jeton, de clé ni de réponse brute d'un fournisseur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionResult } from "@/lib/action";
import { requireAppOwner } from "@/lib/auth";
import * as google from "@/lib/appointments/google";
import { googleCreds } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { CrmError } from "@/lib/crm/service";
import { fetchAccount, FirefliesFailure } from "@/lib/fireflies/client";
import { disconnectAccount, verifyAccount } from "@/lib/mail/service";
import { listMcpGrants, loadConnectors } from "@/lib/connectors/status";
import type { Connector, ConnectorKey } from "@/lib/connectors/types";
import { disconnectGoogleAction } from "@/app/rendez-vous-actions";

const KEY = z.enum(["gmail", "google_calendar", "fireflies", "claude_mcp"]);

async function owned<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<ActionResult<T>> {
  const { supabase } = await requireAppOwner();
  try {
    return { ok: true, data: await fn(supabase) };
  } catch (e) {
    if (e instanceof CrmError || e instanceof z.ZodError) return { ok: false, error: e instanceof z.ZodError ? "Requête invalide." : e.message };
    console.error("connecteurs", e instanceof Error ? e.name : "erreur");
    return { ok: false, error: "L'action a échoué. Rechargez la page pour voir l'état, puis réessayez." };
  }
}

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new CrmError("timeout")), ms))]);

async function record(sb: SupabaseClient, key: ConnectorKey, ok: boolean, message: string) {
  await sb.from("connector_checks").upsert({ key, ok, message: message.slice(0, 300), checked_at: new Date().toISOString() });
}

async function mcpUrl() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/mcp`;
}

/** Vérifie UN connecteur auprès de son fournisseur (délai borné), mémorise le résultat, renvoie sa ligne à jour. */
export async function verifyConnectorAction(key: string): Promise<ActionResult<{ ok: boolean; message: string; connector: Connector | null }>> {
  return owned(async (sb) => {
    const k = KEY.parse(key);
    let res: { ok: boolean; message: string };
    try {
      res = await within(check(sb, k), 15_000);
    } catch (e) {
      res = { ok: false, message: e instanceof CrmError && e.message === "timeout" ? "Le service n'a pas répondu à temps. Réessayez plus tard." : "Vérification impossible pour le moment." };
    }
    await record(sb, k, res.ok, res.message);
    const all = await loadConnectors(sb, await mcpUrl());
    return { ...res, connector: all.find((c) => c.key === k) ?? null };
  });
}

async function check(sb: SupabaseClient, k: z.infer<typeof KEY>): Promise<{ ok: boolean; message: string }> {
  if (k === "gmail") {
    const { data } = await sb.from("mail_accounts").select("id, email").neq("status", "disconnected").order("is_default", { ascending: false }).limit(1).maybeSingle();
    if (!data) return { ok: false, message: "Aucun compte Gmail connecté." };
    return verifyAccount(sb, data.id as string);
  }
  if (k === "google_calendar") {
    let creds;
    try {
      creds = await googleCreds(sb);
    } catch {
      return { ok: false, message: "Google a refusé l'accès ou ne répond pas : voir le détail." };
    }
    if (!creds) return { ok: false, message: "Aucun agenda Google connecté." };
    const cals = await google.listCalendars(creds.token);
    await sb.rpc("appt_google_status", { p_server_key: serverRpcKey(), p_ok: true, p_error: null });
    return { ok: true, message: `Accès confirmé : ${cals.length} agenda(s) visible(s).` };
  }
  if (k === "fireflies") {
    try {
      const a = await fetchAccount(10_000);
      return { ok: true, message: `Clé acceptée par Fireflies${a.email ? ` (${a.email})` : ""}.` };
    } catch (e) {
      if (e instanceof FirefliesFailure && e.code === "auth") return { ok: false, message: "Clé API refusée par Fireflies : remplacez FIREFLIES_API_KEY." };
      if (e instanceof FirefliesFailure && e.code === "not_configured") return { ok: false, message: "Clé API absente du serveur." };
      return { ok: false, message: e instanceof FirefliesFailure ? e.message : "Fireflies n'a pas répondu." };
    }
  }
  const g = await listMcpGrants(sb, 8000);
  if (!g.grants) return { ok: false, message: g.error ?? "Liste des accès indisponible." };
  return { ok: true, message: g.grants.length ? `${g.grants.length} accès accordé(s) à Claude.` : "Aucun accès accordé à Claude." };
}

/** Déconnexion, en réutilisant la fonction du module (révocation chez Google comprise). */
export async function disconnectConnectorAction(key: string): Promise<ActionResult<{ revoked: boolean }>> {
  return owned(async (sb) => {
    const k = z.enum(["gmail", "google_calendar"]).parse(key);
    if (k === "gmail") {
      const { data } = await sb.from("mail_accounts").select("id").neq("status", "disconnected").order("is_default", { ascending: false }).limit(1).maybeSingle();
      if (!data) throw new CrmError("Aucun compte Gmail connecté.");
      return disconnectAccount(sb, data.id as string);
    }
    const r = await disconnectGoogleAction();
    if (!r.ok) throw new CrmError(r.error);
    return { revoked: r.data.revoked };
  });
}

/** Retire l'accès d'UN client Claude (OAuth). Le jeton déjà émis expire au plus tard une heure après. */
export async function revokeMcpGrantAction(clientId: string): Promise<ActionResult<{ remaining: number }>> {
  return owned(async (sb) => {
    const id = z.string().min(1).max(200).parse(clientId);
    const { error } = await sb.auth.oauth.revokeGrant({ clientId: id });
    if (error) throw new CrmError("Le serveur d'autorisation a refusé le retrait de cet accès.");
    const g = await listMcpGrants(sb);
    await record(sb, "claude_mcp", true, `Accès retiré. ${g.grants?.length ?? "?"} accès restant(s).`);
    return { remaining: g.grants?.length ?? 0 };
  });
}
