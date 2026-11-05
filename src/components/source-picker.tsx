"use client";

// Source du contact : badge coloré et sélecteur recherchable avec création rapide.
import { useRouter } from "next/navigation";
import { startTransition, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { createSourceAction } from "@/app/actions";
import type { LeadSource, SourceColor } from "@/lib/crm/types";
import { attempt, useSync } from "@/lib/client/query";
import { cn } from "./ui";

export const SOURCE_COLORS: Record<SourceColor, { dot: string; badge: string; label: string }> = {
  slate: { dot: "bg-slate-400", badge: "bg-slate-100 text-slate-700 border-slate-200", label: "Gris" },
  violet: { dot: "bg-violet", badge: "bg-violet-soft text-violet-strong border-violet-line", label: "Violet" },
  blue: { dot: "bg-blue-500", badge: "bg-blue-50 text-blue-700 border-blue-200", label: "Bleu" },
  green: { dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Vert" },
  amber: { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-800 border-amber-200", label: "Ambre" },
  red: { dot: "bg-rose-500", badge: "bg-rose-50 text-rose-700 border-rose-200", label: "Rouge" },
  pink: { dot: "bg-pink-500", badge: "bg-pink-50 text-pink-700 border-pink-200", label: "Rose" },
  teal: { dot: "bg-teal-500", badge: "bg-teal-50 text-teal-700 border-teal-200", label: "Turquoise" },
};

export function SourceBadge({ source }: { source?: Pick<LeadSource, "name" | "color"> | null }) {
  if (!source) return <span className="text-muted">—</span>;
  const c = SOURCE_COLORS[source.color ?? "slate"];
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 font-label text-[11px] font-semibold", c.badge)}>
      {source.name}
    </span>
  );
}

export function SourcePicker({
  sources,
  value,
  onChange,
  placeholder = "Aucune source",
  className,
}: {
  sources: LeadSource[];
  value: string | null;
  onChange: (id: string | null, source: LeadSource | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [created, setCreated] = useState<LeadSource[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sync = useSync();
  const router = useRouter();
  const all = useMemo(() => [...sources, ...created.filter((c) => !sources.some((s) => s.id === c.id))], [sources, created]);
  const current = all.find((s) => s.id === value) ?? null;
  const needle = q.trim().toLowerCase();
  const shown = all.filter((s) => !s.archived_at && (!needle || s.name.toLowerCase().includes(needle)));
  const exact = all.some((s) => s.name.trim().toLowerCase() === needle);

  function pick(s: LeadSource | null) {
    onChange(s?.id ?? null, s);
    setOpen(false);
    setQ("");
  }
  async function create() {
    setBusy(true);
    const r = await attempt(() => createSourceAction(q.trim()));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setCreated((c) => [...c, r.data]);
    pick(r.data);
    sync();
    startTransition(() => router.refresh()); // la liste des sources vient de la mise en page
  }

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); requestAnimationFrame(() => inputRef.current?.focus()); }}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 text-left text-sm transition-colors hover:border-violet"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? <SourceBadge source={current} /> : <span className="text-muted">{placeholder}</span>}
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default" aria-label="Fermer" onClick={() => setOpen(false)} />
          <div className="pop-in absolute z-40 mt-1 w-full min-w-56 rounded-lg border border-line bg-white p-1.5 shadow-xl">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown[0]) pick(shown[0]);
                  else if (needle) create();
                }
              }}
              placeholder="Rechercher ou créer…"
              className="mb-1 h-8 w-full rounded-md border border-line px-2 text-sm focus:border-violet focus:outline-none"
            />
            <ul role="listbox" className="max-h-52 overflow-y-auto">
              {value && (
                <li>
                  <button type="button" onClick={() => pick(null)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-surface">
                    <X size={12} /> Retirer la source
                  </button>
                </li>
              )}
              {shown.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => pick(s)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-violet-soft">
                    <span className={cn("size-2 rounded-full", SOURCE_COLORS[s.color ?? "slate"].dot)} />
                    <span className="flex-1 truncate">{s.name}</span>
                    {s.id === value && <Check size={13} className="text-violet-strong" />}
                  </button>
                </li>
              ))}
            </ul>
            {needle && !exact && (
              <button type="button" onClick={create} disabled={busy} className="mt-1 flex w-full items-center gap-2 rounded border-t border-line px-2 py-1.5 text-left text-sm font-semibold text-violet-strong hover:bg-violet-soft">
                <Plus size={13} /> Créer « {q.trim()} »
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
