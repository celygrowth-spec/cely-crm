"use client";

// Ajout de prospects existants à une campagne (listes et/ou fiches), sans doublon.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { searchAction } from "@/app/actions";
import { enrollAction } from "@/app/prospection-actions";
import type { SearchResult } from "@/lib/crm/types";
import { useCrm } from "../app-shell";
import { Badge, Button, Input, Modal } from "../ui";

export function EnrollModal({ campaignId, open, onClose }: { campaignId: string; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Ajouter des prospects" wide>
      {open && <EnrollBody campaignId={campaignId} onClose={onClose} />}
    </Modal>
  );
}

function EnrollBody({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const { lists } = useCrm();
  const router = useRouter();
  const [listIds, setListIds] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [picked, setPicked] = useState<SearchResult[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(async () => {
      const r = await searchAction(q);
      if (r.ok) setResults(r.data);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function submit() {
    setPending(true);
    const r = await enrollAction(campaignId, picked.map((x) => x.id), listIds);
    setPending(false);
    if (!r.ok) return toast.error(r.error);
    const { added, already_present, blocked } = r.data;
    toast.success(
      `${added} entreprise(s) ajoutée(s) à préparer` +
        (already_present ? ` · ${already_present} déjà présente(s)` : "") +
        (blocked ? ` · ${blocked} bloquée(s) « Ne plus contacter »` : ""),
    );
    onClose();
    router.refresh();
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <p className="mb-1 font-label text-xs font-semibold text-muted">Listes</p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1.5">
          {lists.map((l) => (
            <label key={l.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface">
              <input type="checkbox" checked={listIds.includes(l.id)} onChange={(e) => setListIds((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id)))} />
              {l.name}
            </label>
          ))}
          {!lists.length && <p className="p-2 text-sm text-muted">Aucune liste.</p>}
        </div>
      </div>
      <div>
        <p className="mb-1 font-label text-xs font-semibold text-muted">Fiches individuelles</p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une entreprise, une personne…" className="h-8" />
        <ul className="mt-1 max-h-40 divide-y divide-line overflow-y-auto">
          {(q.trim() ? results : []).map((r) => (
            <li key={r.id} className="flex items-center justify-between py-1 text-sm">
              <span className="truncate">{r.name}</span>
              <Button size="sm" variant="ghost" disabled={picked.some((x) => x.id === r.id)} onClick={() => setPicked((p) => [...p, r])}>Ajouter</Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-1">
          {picked.map((x) => (
            <Badge key={x.id} tone="violet">
              {x.name}
              <button onClick={() => setPicked((p) => p.filter((y) => y.id !== x.id))} aria-label="Retirer">×</button>
            </Badge>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted md:col-span-2">
        Une entreprise présente dans plusieurs listes n&apos;est inscrite qu&apos;une fois. Les fiches « Ne plus contacter » sont exclues. Les prospects ajoutés sont « à préparer » :
        aucune action n&apos;est proposée avant leur activation.
      </p>
      <div className="flex justify-end md:col-span-2">
        <Button variant="primary" onClick={submit} disabled={pending || (!listIds.length && !picked.length)}>Ajouter à la campagne</Button>
      </div>
    </div>
  );
}
