"use client";

// Image d'un article : adresse http(s).
import { Field, Input } from "@/components/ui";

export function ImageField({ label, value, onChange, field }: { label: string; value: string | null; onChange: (v: string | null) => void; field: string }) {
  return (
    <Field label={label}>
      <Input value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} placeholder="https://…" data-field={field} />
    </Field>
  );
}
