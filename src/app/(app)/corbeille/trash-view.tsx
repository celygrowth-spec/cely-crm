"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { trashPurgeAction, trashRestoreAction } from "@/app/trash-actions";
import { Badge, Button, Card, EmptyState, Modal, Spinner } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatDate } from "@/lib/format";
import { KIND_LABEL, summaryParts, type TrashItem } from "@/lib/trash/types";

type Ask = { kind: "parent"; item: TrashItem; parent: { trash_id: string; label: string; kind: keyof typeof KIND_LABEL } } | { kind: "purge"; item: TrashItem };

export function TrashView({ items, filesPending }: { items: TrashItem[]; filesPending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !gone.has(i.id));
  const hide = (...ids: string[]) => setGone((s) => new Set([...s, ...ids]));

  async function restore(item: TrashItem, withParent = false) {
    if (busy) return;
    setBusy(item.id);
    const r = await attempt(() => trashRestoreAction(item.id, withParent));
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    const d = r.data;
    if (d.restored) {
      hide(item.id);
      setAsk(null);
      toast.success(`« ${d.label} » est restauré`);
      return router.refresh();
    }
    if ("needs_parent" in d) return setAsk({ kind: "parent", item, parent: d.needs_parent });
    // déjà restauré (double clic, autre onglet)
    hide(item.id);
    router.refresh();
  }

  async function purge(item: TrashItem) {
    if (busy) return;
    setBusy(item.id);
    const r = await attempt(() => trashPurgeAction(item.id));
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    setAsk(null);
    hide(item.id);
    if (r.data.filesPending > 0) toast.warning(`Supprimé définitivement. ${r.data.filesPending} fichier(s) n'ont pas pu être retirés du stockage : ils le seront au prochain passage planifié.`);
    else toast.success("Supprimé définitivement");
    router.refresh();
  }

  if (!visible.length) {
    return <EmptyState title="La corbeille est vide" description="Les éléments que vous supprimez apparaissent ici pendant 30 jours." />;
  }
  return (
    <>
      {filesPending > 0 && (
        <p className="mb-3 rounded-lg bg-surface p-3 text-sm text-muted">
          {filesPending} fichier(s) d&apos;éléments déjà purgés restent à retirer du stockage ; ils le seront au prochain passage planifié.
        </p>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm" data-trash-list>
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-semibold">Type</th>
              <th className="px-4 py-2 font-semibold">Nom</th>
              <th className="px-4 py-2 font-semibold">Supprimé le</th>
              <th className="px-4 py-2 font-semibold">Jours restants</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => {
              const parts = summaryParts(i.summary);
              const left = i.days_left;
              return (
                <tr key={i.id} className="border-b border-line last:border-0" data-trash-row={i.id}>
                  <td className="px-4 py-3 whitespace-nowrap"><Badge>{KIND_LABEL[i.kind] ?? i.kind}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">{i.label}</div>
                    {i.context && <div className="text-xs text-muted">{i.context}</div>}
                    {parts.length > 0 && <div className="text-xs text-muted">Avec : {parts.join(", ")}</div>}
                    {i.actor === "claude" && <div className="text-xs text-muted">Supprimé depuis Claude</div>}
                    {i.purge_error && <div className="text-xs text-danger">Purge automatique en échec : {i.purge_error}</div>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDate(i.deleted_at)}</td>
                  <td className="px-4 py-3 whitespace-nowrap" data-days-left={left}>{left === 0 ? "Purge au prochain passage" : `${left} jour${left > 1 ? "s" : ""}`}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => restore(i)} disabled={busy === i.id} data-trash-restore>
                        {busy === i.id ? <Spinner /> : <RotateCcw size={13} aria-hidden />} Restaurer
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setAsk({ kind: "purge", item: i })} disabled={busy === i.id} data-trash-purge>
                        <Trash2 size={13} aria-hidden /> Supprimer définitivement
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Modal open={ask?.kind === "parent"} onClose={() => setAsk(null)} title="Restaurer aussi l'élément parent ?">
        {ask?.kind === "parent" && (
          <div className="space-y-3 text-sm">
            <p>
              « {ask.item.label} » dépend de « {ask.parent.label} » ({KIND_LABEL[ask.parent.kind].toLowerCase()}), qui est encore à la corbeille.
              Il ne peut revenir que si « {ask.parent.label} » revient aussi.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAsk(null)} disabled={!!busy}>Annuler</Button>
              <Button variant="primary" onClick={() => restore(ask.item, true)} disabled={!!busy} data-trash-restore-parent>
                {busy ? <Spinner /> : null} Restaurer les deux
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={ask?.kind === "purge"} onClose={() => !busy && setAsk(null)} title="Supprimer définitivement ?">
        {ask?.kind === "purge" && (
          <div className="space-y-3 text-sm">
            <p>
              « {ask.item.label} »{summaryParts(ask.item.summary).length ? ` et ${summaryParts(ask.item.summary).join(", ")}` : ""} seront supprimés
              définitivement, fichiers stockés compris. <strong>Cette action est irréversible.</strong>
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAsk(null)} disabled={!!busy}>Annuler</Button>
              <Button variant="danger" onClick={() => purge(ask.item)} disabled={!!busy} data-trash-purge-confirm>
                {busy ? <Spinner /> : <Trash2 size={14} aria-hidden />} Supprimer définitivement
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
