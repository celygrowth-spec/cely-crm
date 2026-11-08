"use client";

// Destinataires en pastilles : personnes de la fiche proposées, adresse libre acceptée.
// Entrée, virgule, point-virgule ou sortie du champ valident ; Retour arrière retire la dernière.
import { useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/components/ui";
import { isEmail, splitAddresses } from "@/lib/mail/types";

export type Contact = { id: string; name: string; email: string; title?: string | null; primary?: boolean; first_name?: string | null; last_name?: string | null };

export function RecipientsInput({ label, value, onChange, contacts, autoFocus }: {
  label: string; value: string[]; onChange: (v: string[]) => void; contacts: Contact[]; autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const byEmail = useMemo(() => new Map(contacts.map((c) => [c.email.toLowerCase(), c])), [contacts]);
  const q = text.trim().toLowerCase();
  const suggestions = contacts
    .filter((c) => !value.some((v) => v.toLowerCase() === c.email.toLowerCase()))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    .slice(0, 6);

  const add = (raw: string) => {
    const next = [...value];
    for (const a of splitAddresses(raw)) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    onChange(next);
    setText("");
    setActive(0);
  };
  const remove = (a: string) => onChange(value.filter((x) => x !== a));

  return (
    <div className="relative">
      <div
        className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-white px-2 py-1 focus-within:border-violet focus-within:ring-2 focus-within:ring-violet/20"
        onClick={() => input.current?.focus()}
      >
        <span className="mr-1 shrink-0 text-xs font-semibold text-muted">{label}</span>
        {value.map((a) => {
          const c = byEmail.get(a.toLowerCase());
          const bad = !isEmail(a);
          return (
            <span key={a} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs", bad ? "border-danger/40 bg-danger/5 text-danger" : "border-line bg-surface text-ink")}
              title={bad ? "Adresse invalide" : a} data-recipient={a}>
              <span className="truncate">{c ? <><span className="font-semibold">{c.name}</span> <span className="text-muted">{a}</span></> : a}</span>
              <button type="button" aria-label={`Retirer ${a}`} onClick={(e) => { e.stopPropagation(); remove(a); }} className="rounded-full p-0.5 hover:bg-white"><X size={11} /></button>
            </span>
          );
        })}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={text}
          aria-label={label === "À" ? "Destinataires" : label}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
          placeholder={value.length ? "" : "Nom ou adresse"}
          onFocus={() => setOpen(true)}
          onBlur={() => { setTimeout(() => setOpen(false), 150); if (text.trim()) add(text); }}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;\n]/.test(v)) add(v);
            else { setText(v); setOpen(true); }
          }}
          onPaste={(e) => {
            const v = e.clipboardData.getData("text");
            if (/[,;\s]/.test(v.trim())) { e.preventDefault(); add(v); }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); }
            else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); }
            else if (e.key === "Enter" || (e.key === "Tab" && text.trim())) {
              if (open && suggestions[active] && (q || e.key === "Enter")) { e.preventDefault(); add(suggestions[active].email); }
              else if (text.trim()) { e.preventDefault(); add(text); }
            } else if (e.key === "Backspace" && !text && value.length) remove(value[value.length - 1]);
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-lg">
          {suggestions.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); add(c.email); }} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", i === active ? "bg-violet-soft" : "hover:bg-surface")}>
                <span className="font-semibold">{c.name}</span>
                {c.primary && <span className="rounded-full bg-violet-soft px-1.5 text-[10px] font-semibold text-violet-strong">Principal</span>}
                <span className="ml-auto truncate text-xs text-muted">{c.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
