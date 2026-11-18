"use server";

// Carte des connecteurs : seules écritures possibles, les outils déclarés à la main. Réservées au propriétaire
// (contrôle complet, puis RLS en base). Un double envoi renvoie l'outil déjà créé, sans doublon.
import { z } from "zod";
import type { ActionResult } from "@/lib/action";
import { requireAppOwner } from "@/lib/auth";
import { MAX_DECLARED, type DeclaredTool } from "@/lib/connectors/map-model";

const PARENT = z.string().regex(/^(core|connector:[a-z_]{1,40}|mcp:unknown|mcp:[A-Za-z0-9._:-]{1,200}|tool:[0-9a-f-]{36})$/);
const NAME = z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1, "Saisissez un nom.").max(60, "60 caractères au plus."));

type Row = { id: string; parent_key: string | null; parent_tool: string | null; name: string; created_at: string };
const toTool = (r: Row): DeclaredTool => ({ id: r.id, parentKey: r.parent_key, parentTool: r.parent_tool, name: r.name, createdAt: r.created_at });
const COLS = "id, parent_key, parent_tool, name, created_at";

export async function addMapToolAction(parent: string, name: string): Promise<ActionResult<{ tool: DeclaredTool; existed: boolean }>> {
  const { supabase } = await requireAppOwner();
  const p = PARENT.safeParse(parent);
  const n = NAME.safeParse(name);
  if (!p.success) return { ok: false, error: "Choisissez le nœud auquel l'outil est relié." };
  if (!n.success) return { ok: false, error: n.error.issues[0]?.message ?? "Nom invalide." };
  const isTool = p.data.startsWith("tool:");
  const row: { parent_tool?: string; parent_key?: string; name: string } = isTool ? { parent_tool: p.data.slice(5), name: n.data } : { parent_key: p.data, name: n.data };

  const findExisting = async () => {
    const q = supabase.from("connector_map_tools").select(COLS).ilike("name", n.data.replace(/[\\%_]/g, (c) => `\\${c}`));
    const { data } = await (isTool ? q.eq("parent_tool", row.parent_tool!) : q.eq("parent_key", row.parent_key!)).limit(1).maybeSingle();
    return (data as Row | null) ?? null;
  };
  const existing = await findExisting();
  if (existing) return { ok: true, data: { tool: toTool(existing), existed: true } };
  const { count } = await supabase.from("connector_map_tools").select("id", { count: "exact", head: true });
  if ((count ?? 0) >= MAX_DECLARED) return { ok: false, error: `${MAX_DECLARED} outils déclarés au plus, pour garder la carte lisible.` };

  const { data, error } = await supabase.from("connector_map_tools").insert(row).select(COLS).single();
  if (error) {
    // deux envois simultanés : l'index unique a gardé le premier
    if (error.code === "23505") {
      const again = await findExisting();
      if (again) return { ok: true, data: { tool: toTool(again), existed: true } };
    }
    if (error.code === "23503") return { ok: false, error: "Ce nœud n'existe plus. Rechargez la carte." };
    console.error("carte : ajout d'outil", error.code ?? "erreur");
    return { ok: false, error: "L'outil n'a pas pu être ajouté. Réessayez." };
  }
  return { ok: true, data: { tool: toTool(data as Row), existed: false } };
}

export async function deleteMapToolAction(id: string): Promise<ActionResult<{ removed: number }>> {
  const { supabase } = await requireAppOwner();
  const v = z.string().uuid().safeParse(id);
  if (!v.success) return { ok: false, error: "Requête invalide." };
  const { data, error } = await supabase.from("connector_map_tools").delete().eq("id", v.data).select("id");
  if (error) {
    console.error("carte : suppression d'outil", error.code ?? "erreur");
    return { ok: false, error: "La suppression a échoué. Réessayez." };
  }
  return { ok: true, data: { removed: data?.length ?? 0 } };
}
