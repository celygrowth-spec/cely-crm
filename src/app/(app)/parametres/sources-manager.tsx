"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { createSourceAction, deleteSourceAction, renameSourceAction } from "@/app/actions";
import { Button, Input } from "@/components/ui";
import type { LeadSource } from "@/lib/crm/types";

export function SourcesManager({ sources }: { sources: LeadSource[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const done = (r: { ok: boolean; error?: string }) => { if (!r.ok) toast.error(r.error); else router.refresh(); return r.ok; };
  return (
    <div className="space-y-1.5">
      {sources.map((s) => (
        <div key={s.id} className="flex gap-1">
          <Input defaultValue={s.name} onBlur={async (e) => { if (e.target.value !== s.name) done(await renameSourceAction(s.id, e.target.value)); }} aria-label="Nom de la source" />
          <Button variant="ghost" onClick={async () => { if (confirm(`Supprimer la source « ${s.name} » ?`)) done(await deleteSourceAction(s.id)); }} aria-label="Supprimer"><Trash2 size={14} /></Button>
        </div>
      ))}
      <form onSubmit={async (e) => { e.preventDefault(); if (done(await createSourceAction(name))) setName(""); }} className="flex gap-1 pt-1">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nouvelle source" />
        <Button type="submit" disabled={!name.trim()}><Plus size={14} /> Ajouter</Button>
      </form>
    </div>
  );
}
