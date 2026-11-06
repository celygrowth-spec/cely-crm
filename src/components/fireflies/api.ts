"use client";

import { attempt } from "@/lib/client/query";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Écriture vers une route apiWrite. Une coupure réseau devient un résultat d'échec, jamais une exception. */
export function post<T = null>(url: string, body?: unknown): Promise<Result<T>> {
  return attempt(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (json && typeof json.ok === "boolean") return json as Result<T>;
    return { ok: false as const, error: "L'opération a échoué. Réessayez." };
  });
}
