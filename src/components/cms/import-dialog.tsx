"use client";

// Import de fichiers .md (un ou plusieurs), avec leurs images si elles sont citées par une adresse locale.
// 1. Lecture : le frontmatter remplit les champs ; champs manquants et remarques affichés par fichier.
// 2. Les images jointes partent dans le stockage ; leurs adresses sont remplacées dans l'article.
// 3. Slug déjà utilisé : il faut choisir Remplacer l'article existant ou Créer une copie (brouillon).
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { existingSlugsAction, importEntryAction } from "@/app/cms-actions";
import { Badge, Button, Modal, Select } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis } from "@/lib/cms/dates";
import { baseName, parseMarkdownFile, rewriteImages, type ParsedFile } from "@/lib/cms/frontmatter";
import { STATUS_LABEL } from "@/lib/cms/types";
import { uploadImage } from "./upload";

type Row = { key: string; file: string; parsed: ParsedFile; existing: { id: string; title: string } | null; dupInBatch: boolean; mode: "" | "new" | "replace" | "copy"; result?: string; error?: string; id: string };

export function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function read(files: File[]) {
    setBusy(true);
    setNotes([]);
    const md = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
    const images = new Map(files.filter((f) => f.type.startsWith("image/")).map((f) => [f.name.toLowerCase(), f]));
    const out: string[] = [];
    if (!md.length) out.push("Aucun fichier .md sélectionné.");
    let parsed = await Promise.all(md.map(async (f) => ({ file: f.name, parsed: parseMarkdownFile(await f.text(), f.name) })));
    // images locales : envoi au stockage (une seule fois par nom), puis remplacement des adresses
    const uploaded = new Map<string, string>();
    for (const name of new Set(parsed.flatMap((p) => p.parsed.localImages.map(baseName)))) {
      const f = images.get(name);
      if (!f) continue;
      const r = await uploadImage(f);
      if (r.ok) uploaded.set(name, r.url);
      else out.push(r.error);
    }
    parsed = parsed.map((p) => ({ ...p, parsed: rewriteImages(p.parsed, new Map(p.parsed.localImages.filter((u) => uploaded.has(baseName(u))).map((u) => [u, uploaded.get(baseName(u))!]))) }));
    const existing = await attempt(() => existingSlugsAction(parsed.map((p) => p.parsed.draft.slug)));
    if (!existing.ok) out.push(existing.error);
    const bySlug = new Map((existing.ok ? existing.data : []).map((e) => [e.slug, e]));
    const seen = new Set<string>();
    setRows(parsed.map((p, i) => {
      const slug = p.parsed.draft.slug;
      const dup = seen.has(slug);
      seen.add(slug);
      const ex = bySlug.get(slug) ?? null;
      return { key: `${i}-${p.file}`, file: p.file, parsed: p.parsed, existing: ex, dupInBatch: dup, mode: ex ? "" : dup ? "copy" : "new", id: crypto.randomUUID() };
    }));
    setNotes(out);
    setBusy(false);
  }

  async function run() {
    if (!rows) return;
    setBusy(true);
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const r = next[i];
      if (!r.mode || r.result) continue;
      const res = await attempt(() => importEntryAction({ id: r.id, mode: r.mode as "new" | "replace" | "copy", draft: r.parsed.draft, status: r.parsed.status, publish_at: r.parsed.publish_at }));
      next[i] = res.ok
        ? { ...r, error: undefined, result: res.data.mode === "replace" ? "Remplacé" : res.data.mode === "copy" ? `Copie créée (/${res.data.entry.slug})` : "Importé" }
        : { ...r, error: res.error };
      setRows([...next]);
    }
    setBusy(false);
    router.refresh();
  }

  const pending = rows?.some((r) => !r.mode && !r.result) ?? false;
  return (
    <>
      <Button onClick={() => input.current?.click()} disabled={busy} data-cms-import><FileUp size={15} /> Importer</Button>
      <input ref={input} type="file" multiple accept=".md,.markdown,text/markdown,image/png,image/jpeg,image/webp,image/gif,image/avif" className="hidden" data-cms-import-input
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void read(f); }} />
      <Modal open={!!rows} onClose={() => !busy && setRows(null)} title="Importer des articles" wide>
        <p className="mb-3 text-xs text-muted">Joignez les images citées par une adresse locale en les sélectionnant avec les fichiers .md : elles partent dans le stockage.</p>
        {notes.map((n) => <p key={n} role="alert" className="mb-2 text-sm text-danger">{n}</p>)}
        <ul className="space-y-2" data-import-rows>
          {rows?.map((r, i) => (
            <li key={r.key} className="rounded-xl border border-line p-3 text-sm" data-import-row={r.parsed.draft.slug}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="min-w-0 flex-1 truncate">{r.parsed.draft.title}</strong>
                <Badge>{STATUS_LABEL[r.parsed.status]}{r.parsed.publish_at ? ` · ${formatParis(r.parsed.publish_at)}` : ""}</Badge>
              </div>
              <p className="text-xs text-muted">{r.file} → /{r.parsed.draft.slug}</p>
              {r.parsed.missing.length > 0 && <p className="mt-1 text-xs text-amber-700" data-missing>Champs manquants : {r.parsed.missing.join(", ")}</p>}
              {r.parsed.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-700">{w}</p>)}
              {r.parsed.localImages.length > 0 && <p className="mt-1 text-xs text-danger">Images non fournies (adresses gardées telles quelles) : {r.parsed.localImages.join(", ")}</p>}
              {(r.existing || r.dupInBatch) && !r.result && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{r.existing ? `Le slug existe déjà (« ${r.existing.title} »).` : "Même slug qu'un autre fichier de l'import."}</span>
                  <Select value={r.mode} onChange={(e) => setRows((x) => x!.map((y, k) => (k === i ? { ...y, mode: e.target.value as Row["mode"] } : y)))} className="w-auto" data-import-mode>
                    {r.existing && <option value="">Choisir…</option>}
                    {r.existing && <option value="replace">Remplacer l&apos;article existant</option>}
                    <option value="copy">Créer une copie (brouillon)</option>
                  </Select>
                </div>
              )}
              {r.result && <p className="mt-1 text-xs font-semibold text-emerald-700" data-import-result>{r.result}</p>}
              {r.error && <p className="mt-1 text-xs text-danger" role="alert">{r.error}</p>}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-end gap-2">
          {pending && <span className="text-xs text-amber-700">Choisissez Remplacer ou Créer une copie pour chaque slug existant.</span>}
          <Button onClick={() => setRows(null)} disabled={busy}>Fermer</Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || pending || !rows?.some((r) => r.mode && !r.result)} data-import-run>{busy ? "Import…" : "Importer"}</Button>
        </div>
      </Modal>
    </>
  );
}
