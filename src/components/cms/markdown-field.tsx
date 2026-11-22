"use client";

// Contenu Markdown : écriture, aperçu ou les deux côte à côte. L'aperçu est rendu par le serveur avec le même code
// que pour le site (HTML nettoyé : aucun script). Insertion d'image : envoi au stockage puis ![texte](adresse).
import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, cn } from "@/components/ui";
import { uploadImage } from "./upload";

type Mode = "write" | "preview" | "split";

/** Mise en forme de l'aperçu (sans feuille de style partagée). */
export const PROSE = "[&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-2 [&_p]:leading-relaxed [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-violet-strong [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-3 [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:text-[0.9em] [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg [&_hr]:my-4 [&_hr]:border-line [&_table]:my-3 [&_table]:w-full [&_th]:border [&_th]:border-line [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1";

export function MarkdownField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [mode, setMode] = useState<Mode>("split");
  const [html, setHtml] = useState("");
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "write") return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const res = await fetch("/api/cms/rendu", { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ md: value }) }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { ok: boolean; data?: { html: string } } | null;
      if (ctrl.signal.aborted) return;
      setError(!body?.ok);
      if (body?.ok && body.data) setHtml(body.data.html);
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [value, mode]);

  async function insertImage(f: File) {
    setUploading(true);
    const r = await uploadImage(f);
    setUploading(false);
    if (!r.ok) return toast.error(r.error);
    const alt = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    const el = area.current;
    const at = el ? el.selectionStart : value.length;
    const snippet = `![${alt}](${r.url})`;
    onChange(value.slice(0, at) + snippet + value.slice(at));
    toast.success("Image ajoutée (pensez au texte alternatif entre crochets)");
  }

  return (
    <div data-cms-markdown>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <span className="font-label text-xs font-semibold text-muted">Contenu (Markdown)</span>
        <span className="ml-auto flex gap-1" role="tablist" aria-label="Affichage">
          {([["write", "Écrire"], ["split", "Côte à côte"], ["preview", "Aperçu"]] as const).map(([m, l]) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} data-mode={m}
              className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", mode === m ? "bg-ink text-white" : "text-muted hover:bg-violet-soft")}>{l}</button>
          ))}
        </span>
        <Button size="sm" onClick={() => file.current?.click()} disabled={uploading}><ImagePlus size={13} /> {uploading ? "Envoi…" : "Image"}</Button>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void insertImage(f); }} />
      </div>
      <div className={cn("grid gap-2", mode === "split" && "lg:grid-cols-2")}>
        {mode !== "preview" && (
          <textarea ref={area} rows={24} value={value} onChange={(e) => onChange(e.target.value)} spellCheck
            className="min-h-[24rem] w-full rounded-lg border border-line bg-white p-3 font-mono text-sm outline-none focus:border-violet" data-field="body_md" aria-label="Contenu Markdown" />
        )}
        {mode !== "write" && (
          <div className={cn(PROSE, "min-h-[24rem] overflow-auto rounded-lg border border-line bg-white p-4 text-sm")} data-cms-preview>
            {error ? <p className="text-danger">Aperçu indisponible pour le moment.</p> : <div dangerouslySetInnerHTML={{ __html: html }} />}
          </div>
        )}
      </div>
    </div>
  );
}
