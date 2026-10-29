"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { createListAction, deleteListAction, renameListAction } from "@/app/actions";
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader } from "@/components/ui";

type L = { id: string; name: string; description: string | null; count: number };

export function ListsManager({ lists }: { lists: L[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<L | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function open(l: L | "new") {
    setEdit(l);
    setName(l === "new" ? "" : l.name);
    setDescription(l === "new" ? "" : l.description ?? "");
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = edit === "new" ? await createListAction(name, description) : await renameListAction((edit as L).id, name, description);
    if (!res.ok) return toast.error(res.error);
    toast.success("Liste enregistrée");
    setEdit(null);
    router.refresh();
  }
  async function remove(l: L) {
    if (!confirm(`Supprimer la liste « ${l.name} » ?\n\nLes ${l.count} fiche(s) qu'elle contient ne seront pas supprimées.`)) return;
    const res = await deleteListAction(l.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Liste supprimée, fiches conservées");
    router.refresh();
  }

  return (
    <div>
      <PageHeader
        title="Listes"
        description="Une fiche peut appartenir à plusieurs listes : ce sont des références, jamais des copies."
        actions={<Button variant="primary" onClick={() => open("new")}><Plus size={15} /> Nouvelle liste</Button>}
      />
      {!lists.length ? (
        <EmptyState
          title="Aucune liste"
          description="Créez une liste (ex. « SaaS France », « Agences ») puis ajoutez-y des fiches depuis la base."
          action={<Button variant="primary" onClick={() => open("new")}><Plus size={15} /> Créer une liste</Button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((l) => (
            <Card key={l.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/prospection?list=${l.id}`} className="min-w-0">
                  <p className="truncate font-display text-base font-bold hover:text-violet-strong">{l.name}</p>
                  <p className="text-sm text-muted">{l.count} fiche(s)</p>
                </Link>
                <div className="flex">
                  <Button size="sm" variant="ghost" onClick={() => open(l)} aria-label="Modifier"><Pencil size={14} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(l)} aria-label="Supprimer"><Trash2 size={14} /></Button>
                </div>
              </div>
              {l.description && <p className="mt-2 text-sm text-muted">{l.description}</p>}
            </Card>
          ))}
        </div>
      )}
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "Nouvelle liste" : "Modifier la liste"}>
        <form onSubmit={save} className="space-y-3">
          <Field label="Nom *"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div className="flex justify-end"><Button type="submit" variant="primary">Enregistrer</Button></div>
        </form>
      </Modal>
    </div>
  );
}
