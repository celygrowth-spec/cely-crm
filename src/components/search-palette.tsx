"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchAction } from "@/app/actions";
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
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    if (!q.trim()) return;
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await searchAction(q, archived);
      if (id !== reqId.current) return;
      setLoading(false);
      if (res.ok) {
        setResults(res.data);
        setError(null);
        setActive(0);
      } else setError(res.error);
    }, 180);
    return () => clearTimeout(t);
  }, [q, archived]);

  const shown = q.trim() ? results : [];
  return (
    <>
      <div className="relative">
        <Search size={16} className="absolute top-2.5 left-3 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
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
        {!loading && q.trim() && !shown.length && !error && <p className="text-sm text-muted">Aucun résultat.</p>}
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
