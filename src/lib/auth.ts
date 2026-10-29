import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabase } from "@/lib/supabase/server";

// Vérifie la session ET l'appartenance à app_owner. À appeler dans chaque page et action.
export const requireOwner = cache(async () => {
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  const { data: owner } = await supabase.from("app_owner").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!owner) redirect("/login?error=not_owner");
  return { supabase, user: data.user };
});
