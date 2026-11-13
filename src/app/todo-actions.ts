"use server";

// Productivité › To do list : écritures réservées au propriétaire (contrôle complet, puis RLS en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ActionResult } from "@/lib/action";
import { requireAppOwner } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";
import { createTodo, updateTodo } from "@/lib/todo/service";
import type { TodoItem } from "@/lib/todo/types";

async function owned<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<ActionResult<T>> {
  const { supabase } = await requireAppOwner();
  try {
    return { ok: true, data: await fn(supabase) };
  } catch (e) {
    if (e instanceof CrmError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Données invalides" };
    console.error("todo", e instanceof Error ? e.name : "erreur");
    return { ok: false, error: "L'enregistrement a échoué. Votre saisie est conservée : réessayez." };
  }
}

export async function createTodoAction(input: { id: string; title: string; urgency: string; company_id: string | null }) {
  return owned<TodoItem>((sb) => createTodo(sb, input));
}

export async function updateTodoAction(id: string, patch: { title?: string; urgency?: string; company_id?: string | null; done?: boolean }) {
  return owned<TodoItem>((sb) => updateTodo(sb, id, patch));
}
