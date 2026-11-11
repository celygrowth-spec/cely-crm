import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { getSession } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";

/**
 * Lecture en GET, utilisée par le cache client. Les server actions sont exécutées une par une
 * par Next : une lecture en server action attendrait la fin de toute sauvegarde en cours.
 * Réponses privées : jamais de cache partagé.
 */
export async function apiRead<T>(fn: (sb: SupabaseClient) => Promise<T>) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Session expirée" }, { status: 401 });
  // défense en profondeur (la base filtre déjà tout par RLS) : un compte autre que le propriétaire est refusé net
  const { data: owner } = await session.supabase.rpc("is_app_owner");
  if (owner !== true) return NextResponse.json({ error: "Accès refusé" }, { status: 403 });
  try {
    return NextResponse.json(await fn(session.supabase), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (e instanceof CrmError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Lecture impossible" }, { status: 500 });
  }
}

/**
 * Écriture hors server action, quand une opération longue ne doit pas bloquer les sauvegardes
 * (Next exécute les server actions une par une). Même origine exigée, résultat au format ActionResult.
 */
export async function apiWrite<T>(req: NextRequest, fn: (sb: SupabaseClient) => Promise<T>) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  if (req.headers.get("origin") !== req.nextUrl.origin) return reply({ ok: false, error: "Origine refusée" }, 403);
  const session = await getSession();
  if (!session) return reply({ ok: false, error: "Session expirée. Reconnectez-vous." }, 401);
  try {
    return reply({ ok: true, data: (await fn(session.supabase)) ?? null });
  } catch (e) {
    if (e instanceof CrmError) return reply({ ok: false, error: e.message }, 400);
    if (e instanceof ZodError) return reply({ ok: false, error: e.issues[0]?.message ?? "Données invalides" }, 400);
    console.error(e instanceof Error ? e.name : "Erreur inconnue"); // jamais le contenu : il peut porter un jeton ou un email
    return reply({ ok: false, error: "L'opération a échoué. Réessayez." }, 500);
  }
}
