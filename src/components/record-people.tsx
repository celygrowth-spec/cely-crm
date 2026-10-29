"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Mail, Pencil, Phone, Plus, Star, Trash2 } from "lucide-react";
import { deletePersonAction, upsertPersonAction } from "@/app/actions";
import type { Person } from "@/lib/crm/types";

type PersonConflict = { person_id: string; company_id: string; company_name: string; person_name: string; reason: string };
import { personName } from "@/lib/format";
import { useCrm } from "./app-shell";
import type { RecordCtx } from "./company-record";
import { Badge, Button, Input } from "./ui";

type Draft = { first_name: string; last_name: string; title: string; email: string; phone: string; linkedin_url: string };
const toDraft = (p?: Person): Draft => ({
  first_name: p?.first_name ?? "",
  last_name: p?.last_name ?? "",
  title: p?.title ?? "",
  email: p?.email ?? "",
  phone: p?.phone ?? "",
  linkedin_url: p?.linkedin_url ?? "",
});

export function RecordPeople({ ctx }: { ctx: RecordCtx }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const people = ctx.detail.people;
  return (
    <div className="space-y-2">
      {!people.length && editing !== "new" && <p className="text-sm text-muted">Aucune personne pour l&apos;instant.</p>}
      {people.map((p) =>
        editing === p.id ? (
          <PersonForm key={p.id} ctx={ctx} person={p} onDone={() => setEditing(null)} />
        ) : (
          <PersonRow key={p.id} ctx={ctx} person={p} onEdit={() => setEditing(p.id)} />
        ),
      )}
      {editing === "new" ? (
        <PersonForm ctx={ctx} onDone={() => setEditing(null)} />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setEditing("new")}><Plus size={14} /> Ajouter une personne</Button>
      )}
    </div>
  );
}

function PersonRow({ ctx, person: p, onEdit }: { ctx: RecordCtx; person: Person; onEdit: () => void }) {
  async function makePrimary() {
    const res = await upsertPersonAction(p.company_id, { ...toDraft(p), is_primary: true }, p.id, true);
    if (!res.ok) return toast.error(res.error);
    await ctx.reload();
  }
  async function remove() {
    if (!confirm(`Retirer ${personName(p)} de la fiche ? Les échanges déjà enregistrés sont conservés.`)) return;
    const res = await deletePersonAction(p.id);
    if (!res.ok) return toast.error(res.error);
    await ctx.reload();
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-semibold">
          {personName(p)}
          {p.is_primary && <Badge tone="violet">Contact principal</Badge>}
          {p.title && <span className="font-normal text-muted">· {p.title}</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
          {p.email && <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1 hover:text-violet-strong"><Mail size={12} />{p.email}</a>}
          {p.phone && <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 hover:text-violet-strong"><Phone size={12} />{p.phone}</a>}
          {p.linkedin_url && (
            <a href={/^https?:/.test(p.linkedin_url) ? p.linkedin_url : `https://${p.linkedin_url}`} target="_blank" rel="noreferrer noopener" className="hover:text-violet-strong">
              LinkedIn ↗
            </a>
          )}
        </p>
      </div>
      <div className="flex gap-1">
        {!p.is_primary && <Button size="sm" variant="ghost" onClick={makePrimary} title="Définir comme contact principal"><Star size={14} /></Button>}
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Modifier"><Pencil size={14} /></Button>
        <Button size="sm" variant="ghost" onClick={remove} aria-label="Retirer"><Trash2 size={14} /></Button>
      </div>
    </div>
  );
}

function PersonForm({ ctx, person, onDone }: { ctx: RecordCtx; person?: Person; onDone: () => void }) {
  const { openCompany } = useCrm();
  const [d, setD] = useState<Draft>(toDraft(person));
  const [pending, setPending] = useState(false);
  const [conflicts, setConflicts] = useState<PersonConflict[] | null>(null);

  async function save(force: boolean) {
    setPending(true);
    const res = await upsertPersonAction(ctx.detail.company.id, d, person?.id, force);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.status === "duplicates") return setConflicts(res.data.candidates as unknown as PersonConflict[]);
    toast.success("Personne enregistrée");
    await ctx.reload();
    onDone();
  }
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => { setD({ ...d, [k]: e.target.value }); setConflicts(null); };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="rounded-lg border border-violet-line bg-violet-soft/40 p-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Input placeholder="Prénom" value={d.first_name} onChange={set("first_name")} autoFocus />
        <Input placeholder="Nom" value={d.last_name} onChange={set("last_name")} />
        <Input placeholder="Poste" value={d.title} onChange={set("title")} />
        <Input placeholder="Email" type="email" value={d.email} onChange={set("email")} />
        <Input placeholder="Téléphone" value={d.phone} onChange={set("phone")} />
        <Input placeholder="URL LinkedIn" value={d.linkedin_url} onChange={set("linkedin_url")} />
      </div>
      {conflicts && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm">
          <p className="font-semibold">Cette personne existe peut-être déjà :</p>
          <ul className="mt-1 space-y-1">
            {conflicts.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>{c.person_name || "?"} — {c.company_name} <span className="text-xs text-muted">({c.reason})</span></span>
                <Button size="sm" onClick={() => openCompany(c.company_id)}>Ouvrir</Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => save(true)}>Enregistrer quand même</Button>
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" onClick={onDone}>Annuler</Button>
        <Button size="sm" type="submit" variant="primary" disabled={pending}>Enregistrer</Button>
      </div>
    </form>
  );
}
