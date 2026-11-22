"use client";

// Contenu Markdown de l'article.
import { Field, Textarea } from "@/components/ui";

export function MarkdownField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Contenu (Markdown)">
      <Textarea rows={20} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-sm" data-field="body_md" />
    </Field>
  );
}
