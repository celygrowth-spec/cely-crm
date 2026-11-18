"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setDefaultLibraryAction } from "@/app/generateurs-actions";
import { Card } from "@/components/ui";

type Item = { id: string; name: string; kind: "file" | "prompt"; folder: string };

export function DefaultLibrary({ kind, title, items, initial }: { kind: "proposal" | "onboarding"; title: string; items: Item[]; initial: string[] }) {
  const [selected, setSelected] = useState(() => new Set(initial));
  const [pending, start] = useTransition();
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    setSelected(next);
    start(async () => {
      const r = await setDefaultLibraryAction(kind, [...next]);
      if (!r.ok) {
        setSelected(selected);
        return void toast.error(r.error);
      }
      setSelected(new Set(r.data));
    });
  };
  return (
    <Card className="p-4" data-default-library={kind}>
      <h2 className="font-display text-base font-bold">{title} <span className="text-sm font-normal text-muted">· {selected.size} élément{selected.size > 1 ? "s" : ""} par défaut</span></h2>
      {items.length === 0 ? <p className="mt-2 text-sm text-muted">La bibliothèque est vide.</p> : (
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-sm">
          {items.map((i) => (
            <li key={i.id}>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={selected.has(i.id)} disabled={pending} onChange={(e) => toggle(i.id, e.target.checked)} />
                <span>{i.name}<span className="text-xs text-muted"> · {i.kind === "prompt" ? "Prompt" : "Fichier"} · {i.folder}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
