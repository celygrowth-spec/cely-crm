"use client";

// Cache client unique (TanStack Query) : déduplication, réutilisation des données récentes,
// réponses obsolètes ignorées, données conservées pendant un rafraîchissement.
import { QueryClient, QueryClientProvider, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  // filet de sécurité : une action qui échoue sans être gérée ne passe jamais inaperçue
  useEffect(() => {
    const notify = () => toast.error("Une action n'a pas abouti. Vérifiez votre connexion et réessayez.");
    window.addEventListener("unhandledrejection", notify);
    return () => window.removeEventListener("unhandledrejection", notify);
  }, []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (res.status === 401) {
    // navigation complète voulue : la mémoire du cache privé est effacée avec la page
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
    throw new Error("Session expirée");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? "Chargement impossible");
  return body as T;
}

// Écrans dont les données viennent du cache client : pas besoin de les recharger côté serveur.
const CLIENT_DATA = /^\/(prospection\/base|pipelines\/[^/]+|fiches\/[^/]+)$/;
let routerDirty = false;

/**
 * Après une mutation : invalidation ciblée. Si l'écran affiche des données serveur, il est rafraîchi
 * sans bloquer (le contenu visible reste en place). Sinon, on évite de purger le cache de navigation
 * à chaque clic (cela relançait des dizaines de préchargements) : la purge attend le prochain écran.
 */
export function useSync() {
  const qc = useQueryClient();
  const router = useRouter();
  return useCallback(
    (...keys: QueryKey[]) => {
      keys.forEach((queryKey) => qc.invalidateQueries({ queryKey }));
      qc.invalidateQueries({ queryKey: ["counters"] });
      if (CLIENT_DATA.test(window.location.pathname)) routerDirty = true;
      else startTransition(() => router.refresh());
    },
    [qc, router],
  );
}

/** À monter une fois : applique la purge différée au changement d'écran. */
export function useFlushRouterOnNavigate() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (!routerDirty) return;
    routerDirty = false;
    startTransition(() => router.refresh());
  }, [pathname, router]);
}

/**
 * Exécute une server action en transformant une coupure réseau ou une erreur serveur en résultat
 * d'échec : sans cela l'exception empêcherait le retour en arrière d'une mise à jour optimiste.
 */
export async function attempt<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch {
    return { ok: false, error: "Connexion au serveur impossible. Rien n'a été enregistré." };
  }
}
