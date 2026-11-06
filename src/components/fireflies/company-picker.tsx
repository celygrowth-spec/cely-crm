"use client";

// Recherche d'une fiche existante : un appel ne crée jamais de fiche.
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { apiGet } from "@/lib/client/query";
import type { SearchResult } from "@/lib/crm/types";
import { Input } from "../ui";

export function CompanyPicker({ onPick, disabled }: { onPick: (id: string) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim());
  const res = useQuery({
    queryKey: ["fireflies-company-search", term],
    queryFn: ({ signal }) => apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(term)}`, signal),
    enabled: term.length >= 2,
  });
  return (
    <div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une fiche (nom, domaine, contact)" aria-label="Rechercher une fiche" className="h-9" />
      {term.length >= 2 && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line">
          {res.isLoading && <li className="px-3 py-2 text-xs text-muted">Recherche…</li>}
          {res.isError && <li className="px-3 py-2 text-xs text-danger">{res.error.message}</li>}
          {res.data?.length === 0 && <li className="px-3 py-2 text-xs text-muted">Aucune fiche trouvée.</li>}
          {res.data?.map((c) => (
            <li key={c.id}>
              <button type="button" disabled={disabled} onClick={() => onPick(c.id)} className="w-full px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-50">
                <span className="font-semibold">{c.name}</span>
                {c.website && <span className="ml-2 text-xs text-muted">{c.website}</span>}
                {c.matched && <span className="ml-2 text-xs text-muted">· {c.matched}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
