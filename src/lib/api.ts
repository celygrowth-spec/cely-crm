import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
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
  try {
    return NextResponse.json(await fn(session.supabase), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (e instanceof CrmError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Lecture impossible" }, { status: 500 });
  }
}
