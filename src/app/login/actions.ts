"use server";

import { redirect } from "next/navigation";
import { createSupabase } from "@/lib/supabase/server";

export async function signInAction(_: string | null, form: FormData): Promise<string | null> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  if (!email || !password) return "Email et mot de passe obligatoires.";
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return "Identifiants incorrects.";
  const { data: owner } = await supabase.from("app_owner").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!owner) {
    await supabase.auth.signOut();
    return "Ce compte n'est pas autorisé à accéder au CRM.";
  }
  // uniquement des chemins internes
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
