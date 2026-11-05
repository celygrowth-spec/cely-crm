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
  const adapter: FileAdapter = {
    start: (f) => op({ op: "start", project: projectId, name: f.name, type: f.type, size: f.size }),
    confirm: (file, folder) => op({ op: "confirm", project: projectId, file, folder }),
    abort: (file) => op({ op: "abort", file }),
    url: (id, download) => op({ op: "url", id, download }),
    rename: (id, name) => op({ op: "rename", id, name }),
    move: (id, folder) => op({ op: "move", id, folder }),
    remove: (id) => op({ op: "delete", id }),
    unshare: (id) => op({ op: "unshare", id }),
    createFolder: (name, parent) => op({ op: "folder", project: projectId, name, parent }),
    deleteFolder: (id) => op({ op: "folder-delete", id }),
  };
  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted"><VisibilityTag client /> Tout ce qui figure ici est visible et téléchargeable par les contacts du projet.</div>
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
            <Button className="mt-2" variant="primary" disabled={!pick.length} onClick={async () => {
              const r = await op({ op: "share", project: projectId, files: pick, folder: null });
              if (!r.ok) return toast.error(r.error);
              toast.success(`${pick.length} document(s) partagé(s) avec le projet`);
              setPick([]);
              router.refresh();
            }}><Share2 size={14} /> Partager avec le projet</Button>
          </>
        )}
      </Card>
    </div>
  );
}
