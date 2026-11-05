import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabase } from "@/lib/supabase/server";

/**
 * Session de la requête. getClaims vérifie localement la signature du jeton (ES256), sans
 * appel réseau, contrairement à getUser. Les données restent protégées par RLS et assert_owner,
 * qui refusent tout compte autre que le propriétaire.
 */
export const getSession = cache(async () => {
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { supabase, user: { id: claims.sub as string, email: (claims.email as string | undefined) ?? null } };
});

/** À appeler dans les pages et actions : redirige vers la connexion si la session manque. */
export const requireOwner = cache(async () => {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
});

/** Contrôle complet (appartenance à app_owner) : une fois par mise en page, et pour le consentement OAuth. */
export const requireAppOwner = cache(async () => {
  const session = await requireOwner();
  const { data: owner } = await session.supabase.from("app_owner").select("user_id").eq("user_id", session.user.id).maybeSingle();
  if (!owner) redirect("/login?error=not_owner");
  return session;
});
