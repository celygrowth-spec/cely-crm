"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import type { SearchResult } from "@/lib/crm/types";
import { matchCommands } from "./palette-commands";
import { Badge, cn, Modal, Spinner } from "./ui";

export function SearchPalette({ open, onClose, onPick, onCreate }: { open: boolean; onClose: () => void; onPick: (id: string) => void; onCreate: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Rechercher ou aller à…">
      <SearchBody onPick={onPick} onCreate={onCreate} onClose={onClose} />
    </Modal>
  );
}

type Item = { key: string; run: () => void; node: (active: boolean) => ReactNode; section?: string };

// monté à chaque ouverture : l'état repart de zéro
function SearchBody({ onPick, onCreate, onClose }: { onPick: (id: string) => void; onCreate: () => void; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [archived, setArchived] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

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

  // fiches d'abord quand on cherche ; raccourcis ensuite (ou seuls, sans saisie)
  const commands = matchCommands(q);
  const items: Item[] = [
    ...shown.map((r, i): Item => ({
      key: r.id,
      section: i === 0 ? "Fiches" : undefined,
      run: () => onPick(r.id),
      node: () => (
        <>
          <span className="min-w-0">
            <span className="block truncate font-semibold">{r.name}</span>
            <span className="block truncate text-xs text-muted">{r.matched ?? r.website ?? ""}</span>
          </span>
          {r.archived && <Badge>Archivée</Badge>}
        </>
      ),
    })),
    ...commands.map((c, i): Item => ({
      key: c.id,
      section: i === 0 || commands[i - 1].group !== c.group ? c.group : undefined,
      run: () => {
        onClose();
        if (c.create) onCreate();
        else if (c.href) router.push(c.href);
      },
      node: (on) => (
        <>
          <span className="truncate">{c.label}</span>
          {c.create ? <Plus size={14} className={on ? "text-violet-strong" : "text-muted"} /> : <ArrowRight size={14} className={on ? "text-violet-strong" : "text-muted"} />}
        </>
      ),
    })),
  ];
  const current = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <>
      <div className="relative">
        <Search size={16} className="absolute top-2.5 left-3 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(current + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(current - 1, 0)); }
            if (e.key === "Enter" && items[current]) { e.preventDefault(); items[current].run(); }
          }}
          placeholder="Fiche, personne, email… ou une rubrique"
          aria-label="Rechercher une fiche ou une rubrique"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={items[current] ? `palette-${items[current].key}` : undefined}
          className="h-10 w-full rounded-lg border border-line pr-3 pl-9 text-sm focus:border-violet focus:outline-none"
        />
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Inclure les fiches archivées
      </label>
      <div className="mt-3 min-h-16">
        {loading && <Spinner />}
        {error && <p className="text-sm text-danger">{error}</p>}
        {!loading && !search.isFetching && debounced && !shown.length && !error && <p className="mb-2 text-sm text-muted">Aucune fiche trouvée.</p>}
        <ul ref={list} id="palette-results" role="listbox" aria-label="Résultats" className="max-h-[50vh] overflow-y-auto">
          {items.map((it, i) => (
            <li key={it.key} role="presentation">
              {it.section && <p className="mt-2 mb-1 px-2 font-label text-[11px] font-semibold tracking-wide text-muted uppercase">{it.section}</p>}
              <button
                type="button"
                id={`palette-${it.key}`}
                role="option"
                aria-selected={i === current}
                data-index={i}
                onClick={it.run}
                onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm", i === current && "bg-violet-soft")}
              >
                {it.node(i === current)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
