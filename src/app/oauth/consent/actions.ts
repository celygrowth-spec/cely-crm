"use server";

import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";

export async function decideAction(form: FormData) {
  const id = String(form.get("authorization_id") ?? "");
  const approve = form.get("decision") === "approve";
  const { supabase } = await requireOwner();
  const { data, error } = approve
    ? await supabase.auth.oauth.approveAuthorization(id)
    : await supabase.auth.oauth.denyAuthorization(id);
  if (error || !data) throw new Error(`Décision non enregistrée : ${error?.message ?? "réponse vide"}`);
  redirect(data.redirect_url);
}
