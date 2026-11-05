"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import type { SearchResult } from "@/lib/crm/types";
import { Badge, cn, Modal, Spinner } from "./ui";

export function SearchPalette({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Rechercher une fiche">
      <SearchBody onPick={onPick} />
    </Modal>
  );
}

// monté à chaque ouverture : l'état repart de zéro
function SearchBody({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [archived, setArchived] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 160);
    return () => clearTimeout(t);
  }, [q]);

  // chaque frappe a sa clé : la réponse d'une recherche dépassée est annulée, jamais affichée
  const search = useQuery({
    queryKey: ["search", debounced, archived],
    queryFn: ({ signal }) => apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(debounced)}&archived=${archived ? 1 : 0}`, signal),
    enabled: !!debounced,
    placeholderData: keepPreviousData,
  });
  const shown = q.trim() && debounced ? (search.data ?? []) : [];
  const loading = search.isFetching && !shown.length;
  const error = search.isError ? search.error.message : null;

  return (
    <>
      <div className="relative">
        <Search size={16} className="absolute top-2.5 left-3 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1));
            if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            if (e.key === "Enter" && shown[active]) onPick(shown[active].id);
          }}
          placeholder="Entreprise, personne, email ou domaine"
          className="h-10 w-full rounded-lg border border-line pr-3 pl-9 text-sm focus:border-violet focus:outline-none"
        />
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Inclure les fiches archivées
      </label>
      <div className="mt-3 min-h-16">
        {loading && <Spinner />}
        {error && <p className="text-sm text-danger">{error}</p>}
        {!loading && !search.isFetching && debounced && !shown.length && !error && <p className="text-sm text-muted">Aucun résultat.</p>}
        <ul className="divide-y divide-line">
          {shown.map((r, i) => (
            <li key={r.id}>
              <button
                onClick={() => onPick(r.id)}
                onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left", i === active && "bg-violet-soft")}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{r.name}</span>
                  <span className="block truncate text-xs text-muted">{r.matched ?? r.website ?? ""}</span>
                </span>
                {r.archived && <Badge>Archivée</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
