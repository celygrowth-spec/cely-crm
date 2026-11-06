"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { Button, Card, Select, Skeleton, Textarea } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import { formatBytes } from "@/lib/crm/file-rules";
import { LIBRARY_ACCEPT, LIBRARY_CATEGORIES, MAX_LIBRARY_BYTES, libraryType, type LibraryCategory, type LibraryFile } from "@/lib/crm/diagnostic-rules";

type Library = { instructions: string; files: LibraryFile[] };
const KEY = ["diagnostic-library"];

const op = <T,>(body: Record<string, unknown>) =>
  attempt(async () => {
    const res = await fetch("/api/diagnostic-library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: true; data: T } | { ok: false; error: string };
  });

function Instructions({ initial }: { initial: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const r = await op<null>({ op: "instructions", text });
    setSaving(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Prompt enregistré");
    qc.invalidateQueries({ queryKey: KEY });
  }
  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold">Prompt de diagnostic</h2>
      <p className="mb-3 text-sm text-muted">Collez ici vos consignes. Claude les lit au début de chaque diagnostic : une modification vaut pour les prochains passages.</p>
      <Textarea rows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label="Prompt de diagnostic" />
      <Button className="mt-3" variant="primary" disabled={saving || text === initial} onClick={save}>{saving ? "Enregistrement…" : "Enregistrer le prompt"}</Button>
    </Card>
  );
}

function Files({ files }: { files: LibraryFile[] }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<LibraryCategory>("example");
  const [busy, setBusy] = useState<string[]>([]);

  async function upload(file: File) {
    const type = libraryType(file.name);
    if (!type) return toast.error(`« ${file.name} » : format non autorisé.`);
    if (file.size > MAX_LIBRARY_BYTES) return toast.error(`« ${file.name} » dépasse 25 Mo.`);
    setBusy((b) => [...b, file.name]);
    try {
      const start = await op<{ id: string; signedUrl: string; type: string }>({ op: "start", name: file.name, size: file.size, category });
      if (!start.ok) return toast.error(start.error);
      const put = await attempt(async () => {
        const res = await fetch(start.data.signedUrl, { method: "PUT", headers: { "content-type": start.data.type }, body: file });
        return res.ok ? { ok: true as const, data: null } : { ok: false as const, error: "Transfert interrompu." };
      });
      const done = put.ok ? await op<LibraryFile>({ op: "confirm", id: start.data.id }) : put;
      if (!done.ok) {
        await op({ op: "delete", id: start.data.id }); // pas de fichier fantôme
        return toast.error(`« ${file.name} » : ${done.error}`);
      }
      qc.invalidateQueries({ queryKey: KEY });
    } finally {
      setBusy((b) => b.filter((n) => n !== file.name));
    }
  }

  async function download(f: LibraryFile) {
    const r = await op<string>({ op: "url", id: f.id });
    if (!r.ok) return toast.error(r.error);
    window.location.assign(r.data);
  }

  async function remove(f: LibraryFile) {
    if (!confirm(`Supprimer « ${f.display_name} » de la bibliothèque ?`)) return;
    const r = await op<null>({ op: "delete", id: f.id });
    if (!r.ok) return toast.error(r.error);
    qc.invalidateQueries({ queryKey: KEY });
  }

  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold">Fichiers</h2>
      <p className="mb-3 text-sm text-muted">Vos diagnostics d&apos;exemple, le brandbook, le modèle de design. PDF, PowerPoint, Word, Excel, HTML, texte ou images · 25 Mo maximum.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={category} onChange={(e) => setCategory(e.target.value as LibraryCategory)} aria-label="Catégorie des fichiers à ajouter">
          {Object.entries(LIBRARY_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Button onClick={() => input.current?.click()}><Upload size={14} /> Ajouter des fichiers</Button>
        <input ref={input} type="file" multiple accept={LIBRARY_ACCEPT} className="sr-only" onChange={(e) => { [...(e.target.files ?? [])].forEach(upload); e.target.value = ""; }} />
      </div>
      <ul className="mt-3 space-y-1">
        {busy.map((n) => <li key={n} className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-sm"><Loader2 size={14} className="animate-spin text-violet" /> {n}</li>)}
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface">
            <span className="min-w-0 flex-1 truncate font-medium" title={f.display_name}>{f.display_name}</span>
            <span className="hidden text-xs text-muted sm:inline">{LIBRARY_CATEGORIES[f.category]} · {formatBytes(f.size_bytes)}</span>
            <Button size="sm" variant="ghost" aria-label={`Télécharger ${f.display_name}`} onClick={() => download(f)}><Download size={13} /></Button>
            <Button size="sm" variant="ghost" aria-label={`Supprimer ${f.display_name}`} onClick={() => remove(f)}><Trash2 size={13} /></Button>
          </li>
        ))}
      </ul>
      {!files.length && !busy.length && <p className="mt-3 text-sm text-muted">Aucun fichier pour l&apos;instant.</p>}
    </Card>
  );
}

export function DiagnosticLibrary() {
  const { data, isError, error, refetch } = useQuery({ queryKey: KEY, queryFn: ({ signal }) => apiGet<Library>("/api/diagnostic-library", signal) });
  if (isError) return <p className="text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>;
  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <>
      <Instructions key={data.instructions} initial={data.instructions} />
      <Files files={data.files} />
    </>
  );
}
