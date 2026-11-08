"use client";

// Bibliothèque des modèles : recherche, création, modification, duplication, archivage.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Copy, Pencil, Plus, Search } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Skeleton, cn } from "@/components/ui";
import { TemplateModal, templateOp, useTemplates, type MailTemplate } from "@/components/mail/templates";
import { formatDateTime } from "@/lib/format";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function TemplatesView() {
  const qc = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<MailTemplate | null | "new">(null);
  const list = useTemplates(archived);
  const shown = useMemo(() => {
    const n = norm(q.trim());
    return (list.data ?? []).filter((t) => !n || norm(`${t.name} ${t.category ?? ""} ${t.subject} ${t.body_text}`).includes(n));
  }, [list.data, q]);
  const act = async (body: Record<string, unknown>, msg: string) => {
    const r = await templateOp(body);
    if (!r.ok) return void toast.error(r.error);
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ["mail-templates"] });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute top-2.5 left-3 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un modèle" className="pl-8" aria-label="Rechercher un modèle" />
        </div>
        <div role="group" aria-label="Affichage" className="inline-flex rounded-lg border border-line p-0.5">
          {[false, true].map((a) => (
            <button key={String(a)} type="button" aria-pressed={archived === a} onClick={() => setArchived(a)} className={cn("rounded-md px-3 py-1 text-xs font-semibold", archived === a ? "bg-ink text-white" : "text-muted")}>{a ? "Archivés" : "Actifs"}</button>
          ))}
        </div>
        <Button variant="primary" onClick={() => setEditing("new")}><Plus size={15} /> Nouveau modèle</Button>
      </div>
      {list.isLoading ? <Skeleton className="h-40 w-full" /> : !shown.length ? (
        <EmptyState title={q ? "Aucun modèle ne correspond" : archived ? "Aucun modèle archivé" : "Aucun modèle"}
          description={archived || q ? undefined : "Créez vos bases : premier contact, relance après un appel, envoi d'une proposition…"}
          action={!archived && !q ? <Button variant="primary" onClick={() => setEditing("new")}><Plus size={15} /> Nouveau modèle</Button> : undefined} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-templates>
            <thead><tr className="border-b border-line text-left font-label text-[11px] text-muted"><th className="px-3 py-2">Nom</th><th>Catégorie</th><th>Objet</th><th>Modifié le</th><th /></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0 hover:bg-surface/60">
                  <td className="px-3 py-2"><button className="font-semibold hover:text-violet-strong" onClick={() => setEditing(t)}>{t.name}</button></td>
                  <td>{t.category ? <Badge>{t.category}</Badge> : <span className="text-muted">—</span>}</td>
                  <td className="max-w-64 truncate text-muted">{t.subject || "(sans objet)"}</td>
                  <td className="text-xs whitespace-nowrap text-muted">{formatDateTime(t.updated_at)}</td>
                  <td className="pr-2 text-right whitespace-nowrap">
                    {!archived && <Button size="sm" variant="ghost" aria-label={`Modifier ${t.name}`} onClick={() => setEditing(t)}><Pencil size={13} /></Button>}
                    <Button size="sm" variant="ghost" aria-label={`Dupliquer ${t.name}`} onClick={() => void act({ op: "duplicate", id: t.id }, "Modèle dupliqué")}><Copy size={13} /></Button>
                    {archived
                      ? <Button size="sm" variant="ghost" aria-label={`Restaurer ${t.name}`} onClick={() => void act({ op: "archive", id: t.id, archived: false }, "Modèle restauré")}><ArchiveRestore size={13} /></Button>
                      : <Button size="sm" variant="ghost" aria-label={`Archiver ${t.name}`} onClick={() => void act({ op: "archive", id: t.id, archived: true }, "Modèle archivé : les brouillons et emails déjà créés ne changent pas")}><Archive size={13} /></Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <TemplateModal open={editing !== null} template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
    </div>
  );
}
