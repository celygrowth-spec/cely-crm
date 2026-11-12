"use client";

// Bouton « Supprimer » commun : la confirmation nomme l'élément et ce qui part avec lui, puis « Mettre à la
// corbeille ». Boutons désactivés pendant l'opération (un double clic ne fait rien de plus, et la base renvoie de
// toute façon le même élément). « Annuler » dans la notification restaure aussitôt.
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { trashPreviewAction, trashPutAction, trashRestoreAction } from "@/app/trash-actions";
import { attempt, useSync } from "@/lib/client/query";
import { KIND_LABEL, summaryParts, type TrashKind, type TrashPreview } from "@/lib/trash/types";
import { Button, Modal, Spinner } from "@/components/ui";

type Props = {
  kind: TrashKind;
  id: string;
  /** Texte du bouton ; sans texte, une icône seule (avec libellé accessible). */
  children?: ReactNode;
  size?: "sm" | "md";
  variant?: "ghost" | "danger" | "secondary";
  className?: string;
  /** Appelé après la mise à la corbeille (fermer un panneau, quitter la page de l'élément…). */
  onDone?: () => void;
  /** Clés de cache à invalider en plus du rafraîchissement de l'écran. */
  sync?: unknown[][];
};

export function TrashButton({ kind, id, children, size = "sm", variant = "ghost", className, onDone, sync = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TrashPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useSync();

  async function show() {
    setOpen(true);
    setPreview(null);
    setError(null);
    const r = await attempt(() => trashPreviewAction(kind, id));
    if (r.ok) setPreview(r.data);
    else setError(r.error);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const r = await attempt(() => trashPutAction(kind, id));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return toast.error(r.error);
    }
    setOpen(false);
    refresh(...sync);
    onDone?.();
    const trashId = r.data.trash_id;
    toast.success(`« ${r.data.label} » est dans la corbeille`, {
      description: "Restaurable pendant 30 jours.",
      action: {
        label: "Annuler",
        onClick: async () => {
          const back = await attempt(() => trashRestoreAction(trashId, false));
          if (!back.ok) return toast.error(back.error);
          if (!back.data.restored && "needs_parent" in back.data) return toast.error(`Restaurez d'abord « ${back.data.needs_parent.label} » depuis la Corbeille.`);
          refresh(...sync);
          toast.success("Élément restauré");
        },
      },
    });
  }

  const parts = summaryParts(preview?.summary);
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={show} aria-label={children ? undefined : `Supprimer (${KIND_LABEL[kind].toLowerCase()})`} title="Supprimer">
        <Trash2 size={size === "sm" ? 13 : 15} aria-hidden />
        {children}
      </Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title={`Supprimer · ${KIND_LABEL[kind]}`}>
        {!preview && !error && <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Préparation…</div>}
        {error && !preview && <p className="text-sm text-danger" role="alert">{error}</p>}
        {preview && (
          <div className="space-y-3 text-sm" data-trash-confirm>
            <p>
              <strong>« {preview.label} »</strong>
              {preview.context ? <span className="text-muted"> · {preview.context}</span> : null} partira à la corbeille
              {parts.length ? <> avec :</> : <>.</>}
            </p>
            {parts.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5" data-trash-parts>
                {parts.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
            {preview.warnings.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-surface p-3 text-muted">
                {preview.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            <p className="text-muted">
              Tout disparaît du CRM et du portail client. Vous pouvez le restaurer pendant 30 jours depuis la{" "}
              <Link href="/corbeille" className="underline">Corbeille</Link>. Aucun mail n&apos;est envoyé, l&apos;agenda n&apos;est pas modifié.
            </p>
            {error && <p className="text-danger" role="alert">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
              <Button variant="danger" onClick={confirm} disabled={busy} data-trash-submit>
                {busy ? <Spinner /> : <Trash2 size={14} aria-hidden />} Mettre à la corbeille
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
