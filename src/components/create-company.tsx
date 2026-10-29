"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { createCompanyAction } from "@/app/actions";
import type { DuplicateCandidate } from "@/lib/crm/types";
import { useCrm } from "./app-shell";
import { DuplicateNotice } from "./duplicate-notice";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

export type CreateDefaults = { listId?: string; stageId?: string };

type PersonDraft = { first_name: string; last_name: string; title: string; email: string; phone: string; linkedin_url: string };
const emptyPerson = (): PersonDraft => ({ first_name: "", last_name: "", title: "", email: "", phone: "", linkedin_url: "" });

export function CreateCompanyModal({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: CreateDefaults | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  return (
    <Modal open={defaults !== null} onClose={onClose} title="Nouvelle fiche" wide>
      {defaults && <CreateForm defaults={defaults} onClose={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

// monté à chaque ouverture : formulaire vierge et nouvelle clé d'idempotence
function CreateForm({ defaults, onClose, onCreated }: { defaults: CreateDefaults; onClose: () => void; onCreated: (id: string) => void }) {
  const { sources, lists, pipelines, openCompany } = useCrm();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [tags, setTags] = useState("");
  const [people, setPeople] = useState<PersonDraft[]>([emptyPerson()]);
  const [listId, setListId] = useState(defaults.listId ?? "");
  const [stageId, setStageId] = useState(defaults.stageId ?? "");
  const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [idemKey] = useState(() => crypto.randomUUID());

  const filledPeople = people.filter((p) => Object.values(p).some((v) => v.trim()));

  async function submit(force: boolean) {
    setPending(true);
    setError(null);
    const res = await createCompanyAction(
      {
        name,
        website,
        description,
        source_id: sourceId || null,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      },
      filledPeople,
      { force, idempotencyKey: force ? `${idemKey}-force` : idemKey, listId: listId || null, stageId: stageId || null },
    );
    setPending(false);
    if (!res.ok) return setError(res.error);
    if (res.data.status === "duplicates") return setCandidates(res.data.candidates);
    if (res.data.warning) toast.warning(res.data.warning);
    else toast.success("Fiche créée");
    onCreated(res.data.id);
  }

  const update = (i: number, k: keyof PersonDraft, v: string) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Entreprise *">
            <Input value={name} onChange={(e) => { setName(e.target.value); setCandidates(null); }} required autoFocus />
          </Field>
          <Field label="Site web / domaine">
            <Input value={website} onChange={(e) => { setWebsite(e.target.value); setCandidates(null); }} placeholder="acme.com" />
          </Field>
          <Field label="Source du lead">
            <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">—</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Tags" hint="Séparés par des virgules">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="saas, b2b" />
          </Field>
          <Field label="Description / besoin identifié" className="sm:col-span-2">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-label text-xs font-semibold text-muted">Personnes</p>
            <Button size="sm" variant="ghost" onClick={() => setPeople((p) => [...p, emptyPerson()])}>
              <Plus size={14} /> Ajouter une personne
            </Button>
          </div>
          <div className="space-y-2">
            {people.map((p, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface/50 p-2 sm:grid-cols-6">
                <Input placeholder="Prénom" value={p.first_name} onChange={(e) => update(i, "first_name", e.target.value)} />
                <Input placeholder="Nom" value={p.last_name} onChange={(e) => update(i, "last_name", e.target.value)} />
                <Input placeholder="Poste" value={p.title} onChange={(e) => update(i, "title", e.target.value)} />
                <Input placeholder="Email" type="email" value={p.email} onChange={(e) => { update(i, "email", e.target.value); setCandidates(null); }} />
                <Input placeholder="LinkedIn" value={p.linkedin_url} onChange={(e) => { update(i, "linkedin_url", e.target.value); setCandidates(null); }} />
                <div className="flex gap-1">
                  <Input placeholder="Téléphone" value={p.phone} onChange={(e) => update(i, "phone", e.target.value)} />
                  {people.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-9" aria-label="Retirer" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">La première personne devient le contact principal.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ajouter à une liste">
            <Select value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">—</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Ajouter directement à un pipeline">
            <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">—</option>
              {pipelines.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>

        {candidates && (
          <DuplicateNotice
            candidates={candidates}
            onOpen={(id) => { onClose(); openCompany(id); }}
            onForce={() => submit(true)}
            pending={pending}
          />
        )}
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

        {!candidates && (
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
              {pending ? "Vérification…" : "Créer la fiche"}
            </Button>
          </div>
        )}
      </form>
  );
}
