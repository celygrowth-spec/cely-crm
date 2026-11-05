"use client";

import { useRouter } from "next/navigation";
import { FileLibrary, type FileAdapter, type LibFile, type LibFolder } from "@/components/projects/file-library";

async function op<T>(payload: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/portail/fichiers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) window.location.replace("/portail");
    return res.ok ? { ok: true, data: j as T } : { ok: false, error: j.error ?? "Opération impossible" };
  } catch {
    return { ok: false, error: "Connexion impossible : rien n'a été modifié." };
  }
}

export function PortalFiles({ projectId, folders, files, readOnly }: { projectId: string; folders: LibFolder[]; files: LibFile[]; readOnly: boolean }) {
  const router = useRouter();
  const adapter: FileAdapter = {
    start: (f, folder) => op({ op: "start", project: projectId, folder, name: f.name, type: f.type, size: f.size }),
    confirm: (file) => op({ op: "confirm", file }),
    abort: (file) => op({ op: "abort", file }),
    url: (id, download) => op({ op: "url", id, download }),
    rename: (id, name) => op({ op: "rename", id, name }),
    move: (id, folder) => op({ op: "move", id, folder }),
    remove: (id) => op({ op: "delete", id }),
  };
  return (
    <FileLibrary
      folders={folders}
      files={files}
      adapter={adapter}
      canUpload={!readOnly}
      canManage={(f) => !readOnly && !!f.mine}
      onChanged={() => router.refresh()}
      readOnlyNote={readOnly ? "Projet archivé : les fichiers restent consultables et téléchargeables." : "Vous pouvez renommer, déplacer ou supprimer vos propres dépôts. Les documents de Cely Growth sont en consultation."}
    />
  );
}
