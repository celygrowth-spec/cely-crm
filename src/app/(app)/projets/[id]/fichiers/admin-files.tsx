"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Share2 } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { FileLibrary, type FileAdapter, type LibFile, type LibFolder } from "@/components/projects/file-library";
import { formatDate } from "@/lib/format";
import { VisibilityTag } from "../general";

async function op<T>(payload: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/projets/fichiers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data: j as T } : { ok: false, error: j.error ?? "Opération impossible" };
  } catch {
    return { ok: false, error: "Connexion impossible : rien n'a été modifié." };
  }
}

export function AdminFiles({ projectId, companyId, folders, files, internal }: {
  projectId: string; companyId: string; folders: LibFolder[]; files: LibFile[]; internal: { id: string; display_name: string; created_at: string }[];
}) {
  const router = useRouter();
  const [pick, setPick] = useState<string[]>([]);
  // C06 : dossier choisi, et confirmation explicite si le partage rend des documents visibles du client
  const [dest, setDest] = useState(folders.find((f) => f.visible === false)?.id ?? "");
  const [pending, setPending] = useState<number | null>(null);
  async function share(confirm: boolean) {
    const r = await op<{ shared?: number; visible?: boolean; confirm?: number }>({ op: "share", project: projectId, files: pick, folder: dest || null, confirm });
    if (!r.ok) return toast.error(r.error);
    if (r.data.confirm) return setPending(r.data.confirm);
    setPending(null);
    toast.success(`${r.data.shared ?? 0} document(s) ajouté(s) au projet${r.data.visible ? " : visibles du client" : " (non visibles du client)"}`);
    setPick([]);
    router.refresh();
  }
  const adapter: FileAdapter = {
    start: (f) => op({ op: "start", project: projectId, name: f.name, type: f.type, size: f.size }),
    confirm: (file, folder) => op({ op: "confirm", project: projectId, file, folder }),
    abort: (file) => op({ op: "abort", file }),
    url: (id, download) => op({ op: "url", id, download }),
    rename: (id, name) => op({ op: "rename", id, name }),
    move: (id, folder, confirm) => op({ op: "move", project: projectId, ids: [id], folder, confirm }),
    remove: (id) => op({ op: "delete", id }),
    unshare: (id) => op({ op: "unshare", id }),
    saveFolder: (f, confirm) => op({ op: "folder-save", project: projectId, ...f, confirm }),
    deleteFolder: (id, target, confirm) => op({ op: "folder-delete", id, target, confirm }),
  };
  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted"><VisibilityTag client /> La racine et les dossiers partagés sont visibles et téléchargeables par les contacts du projet ; les dossiers marqués « Interne » ne le sont jamais.</div>
      <FileLibrary folders={folders} files={files} adapter={adapter} canUpload canManage={() => true} onChanged={() => router.refresh()} />
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between"><h2 className="font-display text-base font-bold">Documents de la fiche non partagés</h2><VisibilityTag client={false} /></div>
        <p className="mb-2 text-xs text-muted">Un document interne n&apos;est jamais publié automatiquement. Le partage crée une référence : aucun doublon, le document reste dans la <Link className="underline" href={`/fiches/${companyId}`}>fiche CRM</Link>.</p>
        {internal.length === 0 ? <p className="text-sm text-muted">Aucun autre document dans la fiche.</p> : (
          <>
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {internal.map((f) => (
                <li key={f.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pick.includes(f.id)} onChange={(e) => setPick(e.target.checked ? [...pick, f.id] : pick.filter((x) => x !== f.id))} /> {f.display_name} <span className="text-xs text-muted">{formatDate(f.created_at)}</span></label></li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-2" data-share>
              <label className="text-xs text-muted" htmlFor="share-folder">Destination</label>
              <select id="share-folder" value={dest} onChange={(e) => setDest(e.target.value)} className="h-8 rounded-lg border border-line px-2 text-sm">
                <option value="">Racine du projet (visible du client si le projet est publié)</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}{f.visible === false ? " (interne)" : ""}</option>)}
              </select>
              <Button variant="primary" disabled={!pick.length} onClick={() => void share(false)}><Share2 size={14} /> Partager avec le projet</Button>
            </div>
            {pending != null && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" role="alertdialog" data-share-confirm>
                <p><strong>{pending} document(s) deviendront visibles et téléchargeables par les contacts du projet.</strong></p>
                <p className="mt-1 text-xs text-muted">{internal.filter((f) => pick.includes(f.id)).map((f) => f.display_name).join(", ")} → {dest ? folders.find((f) => f.id === dest)?.name : "racine du projet"}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => void share(true)}>Confirmer le partage</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Annuler</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
