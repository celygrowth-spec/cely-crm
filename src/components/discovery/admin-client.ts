"use client";

// Appels du panneau de suivi (propriétaire) vers /api/projets/[id]/decouverte.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "@/lib/client/query";
import type { DiscoveryAdmin } from "@/lib/discovery/types";

export const discoveryKey = (projectId: string) => ["discovery", projectId] as const;

export function useDiscoveryAdmin(projectId: string) {
  return useQuery({ queryKey: discoveryKey(projectId), queryFn: ({ signal }) => apiGet<DiscoveryAdmin>(`/api/projets/${projectId}/decouverte`, signal) });
}

export function useRefreshDiscovery(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: discoveryKey(projectId) });
}

export async function discoveryOp<T = unknown>(projectId: string, payload: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/projets/${projectId}/decouverte`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({ ok: false, error: "Réponse illisible" }));
    return j.ok ? { ok: true, data: j.data as T } : { ok: false, error: j.error ?? "Opération impossible" };
  } catch {
    return { ok: false, error: "Connexion impossible : rien n'a été modifié." };
  }
}

export const portalOnboardingPath = (projectId: string) => `/portail/p/${projectId}/onboarding`;
