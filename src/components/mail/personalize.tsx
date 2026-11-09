"use client";

// Personnalisation d'un email : contact de référence des variables (jamais choisi en silence quand
// plusieurs personnes reçoivent le message), formule collective, et variables sans valeur à remplacer
// ou à retirer avant l'envoi.
import { useState } from "react";
import { AlertTriangle, Braces } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { labelOf, type VariableKey } from "@/lib/mail/variables";
import type { Contact } from "./recipients";

export function PersonalizationBar({ used, contacts, recipients, personId, collective, missing, onReference, onReplace }: {
  used: VariableKey[]; contacts: Contact[]; recipients: string[]; personId: string | null; collective: boolean; missing: VariableKey[];
  onReference: (personId: string | null, collective: boolean) => void; onReplace: (key: VariableKey, text: string) => void;
}) {
  if (!used.length) return null;
  const inMessage = contacts.filter((c) => recipients.some((r) => r.toLowerCase() === c.email.toLowerCase()));
  const options = inMessage.length ? inMessage : contacts;
  const value = collective ? "__collective" : personId && options.some((c) => c.id === personId) ? personId : "";
  const several = recipients.length > 1;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface/50 px-3 py-2 text-sm" data-personalize>
      <div className="flex flex-wrap items-center gap-2">
        <Braces size={14} className="text-violet-strong" aria-hidden />
        <span className="font-semibold">Variables</span>
        <span className="text-muted">personnalisées avec</span>
        <Select value={value} onChange={(e) => onReference(e.target.value === "__collective" || !e.target.value ? null : e.target.value, e.target.value === "__collective")}
          className="h-8 w-auto min-w-48" aria-label="Contact de référence pour les variables">
          <option value="">{several ? "Choisissez un contact…" : "Aucun contact"}</option>
          {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          {several && <option value="__collective">Formule collective (sans prénom ni nom)</option>}
        </Select>
        {several && !value && <span className="text-xs font-semibold text-warning">Plusieurs destinataires : indiquez qui sert de référence, ou une formule collective.</span>}
      </div>
      {missing.length > 0 && (
        <ul className="space-y-1.5" data-missing>
          {missing.map((k) => <MissingRow key={k} k={k} collective={collective} onReplace={onReplace} />)}
        </ul>
      )}
    </div>
  );
}

function MissingRow({ k, collective, onReplace }: { k: VariableKey; collective: boolean; onReplace: (key: VariableKey, text: string) => void }) {
  const [text, setText] = useState(collective && k === "prenom" ? "à tous" : "");
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5" data-missing-var={k}>
      <AlertTriangle size={13} className="text-warning" aria-hidden />
      <span className="text-sm"><span className="font-semibold">{labelOf(k)}</span> {collective ? "n'a pas de sens dans une formule collective" : "n'a pas de valeur pour ce contact"}.</span>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remplacer par…" aria-label={`Remplacer ${labelOf(k)} par`}
        className="h-7 w-40 rounded-md border border-line bg-white px-2 text-xs outline-none focus:border-violet" />
      <Button size="sm" disabled={!text.trim()} onClick={() => onReplace(k, text.trim())}>Remplacer</Button>
      <Button size="sm" variant="ghost" onClick={() => onReplace(k, "")}>Retirer</Button>
    </li>
  );
}
