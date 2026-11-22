"use client";

// Image d'un article (couverture, partage) : envoi au stockage ou adresse http(s), avec vignette.
import { Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input } from "@/components/ui";
import { uploadImage } from "./upload";

export function ImageField({ label, value, onChange, field }: { label: string; value: string | null; onChange: (v: string | null) => void; field: string }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function pick(f: File) {
    setBusy(true);
    const r = await uploadImage(f);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    onChange(r.url);
  }
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- vignette d'une adresse quelconque */}
        {value && /^https?:\/\//.test(value) && <img src={value} alt="" className="h-9 w-14 shrink-0 rounded border border-line object-cover" />}
        <Input value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} placeholder="https://… ou envoyer une image" data-field={field} />
        <Button onClick={() => file.current?.click()} disabled={busy} title="Envoyer une image"><Upload size={14} /> {busy ? "Envoi…" : "Envoyer"}</Button>
        {value && <Button variant="ghost" onClick={() => onChange(null)} aria-label="Retirer l'image"><X size={14} /></Button>}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
      </div>
    </Field>
  );
}
