import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

// Client lié à la session de l'utilisateur (cookies). Toutes les requêtes passent par RLS.
export async function createSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // appelé depuis un Server Component : le proxy se charge de rafraîchir la session
        }
      },
    },
  });
}

// Client lié à un jeton d'accès OAuth (connecteur Claude). Même RLS que l'interface.
export function createSupabaseForToken(accessToken: string): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
