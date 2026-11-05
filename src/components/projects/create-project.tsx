"use client";

// Création rapide d'un projet : entreprise CRM existante, contacts de cette entreprise. Le reste se complète ensuite.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { companyPeopleAction, createProjectAction } from "@/app/projets-actions";
import { Button, Field, Input, Modal, Textarea } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import type { SearchResult } from "@/lib/crm/types";

type Person = { id: string; first_name: string | null; last_name: string | null; email: string | null };

export function CreateProjectModal({ open, onClose, company: initial }: { open: boolean; onClose: () => void; company?: { id: string; name: string } }) {
  return (
    <Modal open={open} onClose={onClose} title="Nouveau projet">
      {open && <Form onClose={onClose} initial={initial} />}
    </Modal>
  );
}

function Form({ onClose, initial }: { onClose: () => void; initial?: { id: string; name: string } }) {
  const router = useRouter();
  const [company, setCompany] = useState<{ id: string; name: string } | null>(initial ?? null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["search", debounced, false],
    queryFn: ({ signal }) => apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(debounced)}`, signal),
    enabled: !company && debounced.length >= 2,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!company) return;
    let live = true;
    void attempt(() => companyPeopleAction(company.id)).then((r) => {
      if (!live || !r.ok) return;
      setPeople(r.data);
      setSelected(r.data.slice(0, 1).map((p) => p.id));
    });
    return () => {
      live = false;
    };
  }, [company]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!company) return;
    setBusy(true);
    setError(null);
    const r = await attempt(() => createProjectAction({ company_id: company.id, name, description, start_date: start || null, end_date: end || null, person_ids: selected }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success("Projet créé");
    onClose();
    router.push(`/projets/${r.data.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {company ? (
        <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <span>Entreprise : <strong>{company.name}</strong></span>
          {!initial && <button type="button" className="text-xs font-semibold text-violet-strong underline" onClick={() => { setCompany(null); setPeople([]); setSelected([]); }}>Changer</button>}
        </div>
      ) : (
        <Field label="Entreprise (fiche CRM)">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une fiche…" autoFocus />
          {debounced.length >= 2 && (
            <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-line">
              {(search.data ?? []).map((r) => (
                <li key={r.id}>
                  <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-surface" onClick={() => { setCompany({ id: r.id, name: r.name }); if (!name) setName(""); }}>
                    {r.name} {r.matched && <span className="text-xs text-muted">· {r.matched}</span>}
                  </button>
                </li>
              ))}
              {search.data?.length === 0 && <li className="px-3 py-1.5 text-sm text-muted">Aucune fiche. Créez-la d&apos;abord dans le CRM.</li>}
            </ul>
          )}
        </Field>
      )}
      <Field label="Nom du projet"><Input required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} placeholder="Refonte du site" /></Field>
      <Field label="Description courte (facultatif)"><Textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-16" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Début"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Fin prévue"><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      {company && (
        <fieldset>
          <legend className="mb-1 font-label text-xs font-semibold text-muted">Contacts clients du projet</legend>
          {people.length === 0 ? <p className="text-sm text-muted">Aucun contact sur cette fiche : ajoutez-en depuis le CRM.</p> : (
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                    {[p.first_name, p.last_name].filter(Boolean).join(" ") || p.email} {p.email && <span className="text-xs text-muted">{p.email}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted">Aucun accès n&apos;est créé ici : vous générerez les codes depuis le projet.</p>
        </fieldset>
      )}
      {error && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={busy || !company || !name.trim()}>{busy ? "Création…" : "Créer le projet"}</Button>
      </div>
    </form>
  );
}
