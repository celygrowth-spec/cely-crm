"use client";

// Bibliothèque d'images : envoi, copie de l'adresse, suppression. Une image utilisée (article ou page SEO) n'est
// supprimée qu'après un avertissement qui nomme ses usages et une confirmation explicite.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { deleteMediaAction } from "@/app/cms-actions";
import { Button, EmptyState, Modal, PageHeader } from "@/components/ui";
import { uploadImage } from "@/components/cms/upload";
import { attempt } from "@/lib/client/query";
import type { CmsMedia, MediaUsage } from "@/lib/cms/media";

export function MediaView({ media }: { media: CmsMedia[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<{ m: CmsMedia; usage: MediaUsage[] } | null>(null);

  async function upload(files: File[]) {
    setBusy(true);
    for (const f of files) {
      const r = await uploadImage(f);
      if (!r.ok) toast.error(r.error);
    }
    setBusy(false);
    router.refresh();
  }

  async function remove(m: CmsMedia, confirmed: boolean) {
    setBusy(true);
    const r = await attempt(() => deleteMediaAction(m.id, confirmed));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (!r.data.deleted) return setWarn({ m, usage: r.data.usage });
    setWarn(null);
    toast.success("Image supprimée");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-5xl" data-cms-media>
      <PageHeader title="Images" description="Images publiées avec les articles. Une image utilisée ne se supprime qu'après avertissement."
        actions={<Button variant="primary" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} /> {busy ? "Envoi…" : "Envoyer des images"}</Button>} />
      <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="hidden"
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
      {!media.length ? <EmptyState title="Aucune image" description="Envoyez des images ici ou depuis l'éditeur d'un article." /> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m) => (
            <li key={m.id} className="overflow-hidden rounded-xl border border-line bg-white" data-media={m.path}>
              {/* eslint-disable-next-line @next/next/no-img-element -- image du stockage public */}
              <img src={m.url} alt="" className="aspect-video w-full bg-surface object-cover" loading="lazy" />
              <div className="flex items-center gap-1 p-2">
                <span className="min-w-0 flex-1 truncate text-xs" title={m.filename}>{m.filename}</span>
                <Button size="sm" variant="ghost" aria-label="Copier l'adresse" onClick={() => void navigator.clipboard.writeText(m.url).then(() => toast.success("Adresse copiée"))}><Copy size={13} /></Button>
                <Button size="sm" variant="ghost" aria-label="Supprimer" disabled={busy} onClick={() => void remove(m, false)} data-media-delete><Trash2 size={13} /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!warn} onClose={() => setWarn(null)} title="Image utilisée">
        <p className="text-sm">Cette image est utilisée ; la supprimer la fera disparaître de ces contenus (y compris sur le site) :</p>
        <ul className="my-3 list-disc pl-5 text-sm" data-media-usage>
          {warn?.usage.map((u) => (
            <li key={`${u.kind}-${u.id}`}>
              {u.kind === "article" ? <Link href={`/cms/articles/${u.id}`} className="font-semibold text-violet-strong hover:underline">{u.label}</Link> : <Link href="/cms/pages" className="font-semibold text-violet-strong hover:underline">Page {u.label}</Link>}
              <span className="text-muted"> ({u.where.join(", ")})</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setWarn(null)}>Garder l&apos;image</Button>
          <Button variant="danger" disabled={busy} onClick={() => warn && void remove(warn.m, true)} data-media-delete-confirm>Supprimer quand même</Button>
        </div>
      </Modal>
    </div>
  );
}
