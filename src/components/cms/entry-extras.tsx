"use client";

// Actions secondaires d'un article : export .md (frontmatter et contenu), aperçu sur le site (lien temporaire de
// 24 h au plus, qui montre aussi un brouillon), retrait des aperçus.
import { Download, Eye } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { previewAction, revokePreviewsAction } from "@/app/cms-actions";
import { Button, Modal, Select } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis } from "@/lib/cms/dates";
import type { CmsEntry } from "@/lib/cms/types";

export function EntryExtras({ entry }: { entry: CmsEntry }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("24");
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const r = await attempt(() => previewAction(entry.id, Number(hours)));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setLink(r.data);
    window.open(r.data.url, "_blank", "noopener");
  }
  async function revoke() {
    const r = await attempt(() => revokePreviewsAction(entry.id));
    if (!r.ok) return toast.error(r.error);
    setLink(null);
    toast.success(`${r.data} lien(s) d'aperçu retiré(s)`);
  }
  return (
    <>
      <Button onClick={() => setOpen(true)} data-preview-open><Eye size={14} /> Aperçu sur le site</Button>
      <a href={`/api/cms/export?id=${entry.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-semibold hover:border-violet" data-export-one>
        <Download size={14} /> Exporter .md
      </a>
      <Modal open={open} onClose={() => setOpen(false)} title="Aperçu sur le site">
        <div className="space-y-3 text-sm">
          <p>Un lien temporaire montre cet article sur le site tel qu&apos;il est enregistré, même en brouillon. Il n&apos;est pas indexé et expire seul.</p>
          <label className="flex items-center gap-2">Valable
            <Select value={hours} onChange={(e) => setHours(e.target.value)} className="w-auto" data-preview-hours>
              {["1", "4", "12", "24"].map((h) => <option key={h} value={h}>{h} h</option>)}
            </Select>
          </label>
          {link && (
            <div className="rounded-lg border border-line bg-surface p-2" data-preview-link>
              <p className="break-all font-mono text-xs">{link.url}</p>
              <p className="mt-1 text-xs text-muted">Expire le {formatParis(link.expires_at)}.</p>
              <Button size="sm" className="mt-2" onClick={() => void navigator.clipboard.writeText(link.url).then(() => toast.success("Lien copié"))}>Copier le lien</Button>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => void revoke()}>Retirer tous les liens d&apos;aperçu</Button>
            <Button variant="primary" disabled={busy} onClick={() => void create()} data-preview-create>{busy ? "Création…" : "Créer et ouvrir le lien"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
