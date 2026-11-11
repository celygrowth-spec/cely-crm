"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { addToListAction, createCompanyAction, getCompanyAction, moveCompanyAction, updateCompanyAction, upsertPersonAction } from "@/app/actions";
import type { DuplicateCandidate } from "@/lib/crm/types";
import { planCompletion, type PersonDraft } from "@/lib/crm/complete-existing";
import { attempt, useSync } from "@/lib/client/query";
import { useCrm } from "./app-shell";
import { SourcePicker } from "./source-picker";
import { DuplicateNotice } from "./duplicate-notice";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

export type CreateDefaults = { listId?: string; stageId?: string };

const emptyPerson = (): PersonDraft => ({ first_name: "", last_name: "", title: "", email: "", phone: "", linkedin_url: "" });

export function CreateCompanyModal({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: CreateDefaults | null;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  return (
    <Modal open={defaults !== null} onClose={onClose} title="Nouvelle fiche" wide>
      {defaults && <CreateForm defaults={defaults} onClose={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

type Draft = { name: string; website: string; description: string; sourceId: string; tags: string; people: PersonDraft[]; listId: string; stageId: string };
// Saisie mise de côté quand on part ouvrir la fiche existante signalée comme doublon : elle est reprise à la
// prochaine ouverture de « Nouvelle fiche » (même onglet), jusqu'à création, complétion ou « Effacer ».
let kept: Draft | null = null;
const keepDraft = (d: Draft | null) => { kept = d; };

// monté à chaque ouverture : nouvelle clé d'idempotence ; formulaire vierge, ou saisie mise de côté
function CreateForm({ defaults, onClose, onCreated }: { defaults: CreateDefaults; onClose: () => void; onCreated: (id: string, name: string) => void }) {
  const { sources, lists, pipelines, openCompany } = useCrm();
  const [restored] = useState(() => kept);
  const [name, setName] = useState(restored?.name ?? "");
  const [website, setWebsite] = useState(restored?.website ?? "");
  const [description, setDescription] = useState(restored?.description ?? "");
  const [sourceId, setSourceId] = useState(restored?.sourceId ?? "");
  const [tags, setTags] = useState(restored?.tags ?? "");
  const [people, setPeople] = useState<PersonDraft[]>(restored?.people ?? [emptyPerson()]);
  const [listId, setListId] = useState(defaults.listId ?? restored?.listId ?? "");
  const [stageId, setStageId] = useState(defaults.stageId ?? restored?.stageId ?? "");
  const [more, setMore] = useState(!!(restored && (restored.description || restored.sourceId || restored.tags)));
  const [completing, setCompleting] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [idemKey] = useState(() => crypto.randomUUID());
  const sync = useSync();

  const filledPeople = people.filter((p) => Object.values(p).some((v) => v.trim()));

  async function submit(force: boolean) {
    setPending(true);
    setError(null);
    const res = await attempt(() => createCompanyAction(
      {
        name,
        website,
        description,
        source_id: sourceId || null,
        tags: tagList(),
      },
      filledPeople,
      { force, idempotencyKey: force ? `${idemKey}-force` : idemKey, listId: listId || null, stageId: stageId || null },
    ));
    setPending(false);
    if (!res.ok) return setError(res.error);
    if (res.data.status === "duplicates") return setCandidates(res.data.candidates);
    keepDraft(null);
    sync(["companies"], ["pipeline-cards"]);
    if (res.data.warning) toast.warning(res.data.warning);
    else toast.success("Fiche créée");
    onCreated(res.data.id, name);
  }

  const tagList = () => tags.split(",").map((t) => t.trim()).filter(Boolean);

  /** Part ouvrir la fiche existante : la saisie est gardée pour la prochaine « Nouvelle fiche ». */
  function openExisting(id: string) {
    keepDraft({ name, website, description, sourceId, tags, people, listId, stageId });
    onClose();
    openCompany(id);
  }

  /** Ajoute à la fiche existante ce qu'elle n'a pas encore (aucune valeur remplie n'est remplacée), puis l'ouvre. */
  async function completeExisting(id: string) {
    setCompleting(id);
    setError(null);
    const fail = (msg: string) => { setCompleting(null); setError(msg); };
    const detail = await attempt(() => getCompanyAction(id));
    if (!detail.ok) return fail(detail.error);
    if (!detail.data) return fail("Fiche introuvable.");
    const { company, people: existing, lists: memberOf } = detail.data;
    const plan = planCompletion(company, existing, { website, description, source_id: sourceId, tags: tagList() }, filledPeople);
    const done: string[] = [];
    if (Object.keys(plan.patch).length) {
      const r = await attempt(() => updateCompanyAction(id, plan.patch));
      if (!r.ok) return fail(r.error);
      if (r.data.status === "duplicates") return fail(`Le site web saisi correspond aussi à ${r.data.candidates.map((c) => c.name).join(", ")} : fiche non modifiée.`);
    }
    done.push(...plan.summary);
    for (const p of plan.add) {
      const r = await attempt(() => upsertPersonAction(id, p));
      if (!r.ok) return fail(`Ajout de ${[p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "la personne"} : ${r.error}`);
    }
    for (const f of plan.fill) {
      const r = await attempt(() => upsertPersonAction(id, f.person, f.id));
      if (!r.ok) return fail(r.error);
    }
    if (listId && !memberOf.some((l) => l.id === listId)) {
      const r = await attempt(() => addToListAction(listId, [id]));
      if (!r.ok) return fail(r.error);
      done.push("liste");
    }
    let stageNote = "";
    if (stageId && !company.stage_id && company.deal_status === "open") {
      const r = await attempt(() => moveCompanyAction(id, stageId));
      if (!r.ok) return fail(r.error);
      done.push("pipeline");
    } else if (stageId && company.stage_id !== stageId) stageNote = " L'étape de pipeline existante n'a pas été changée.";
    keepDraft(null);
    sync(["companies"], ["pipeline-cards"], ["company", id], ["company-timeline", id]);
    toast.success(done.length ? `${company.name} complétée : ${done.join(", ")}.${stageNote}` : `Rien à ajouter : ${company.name} contient déjà ces informations.${stageNote}`);
    onClose();
    openCompany(id);
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
        {restored && (
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-violet-soft px-3 py-2 text-sm text-ink" role="status">
            Saisie précédente reprise.
            <button type="button" className="font-semibold text-violet-strong hover:underline" onClick={() => {
              keepDraft(null);
              setName(""); setWebsite(""); setDescription(""); setSourceId(""); setTags(""); setPeople([emptyPerson()]);
              setListId(defaults.listId ?? ""); setStageId(defaults.stageId ?? ""); setCandidates(null); setMore(false);
            }}>Effacer</button>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Entreprise *">
            <Input value={name} onChange={(e) => { setName(e.target.value); setCandidates(null); }} required autoFocus />
          </Field>
          <Field label="Site web / domaine">
            <Input value={website} onChange={(e) => { setWebsite(e.target.value); setCandidates(null); }} placeholder="acme.com" />
          </Field>
          {more && (
            <>
              <Field label="Source du contact">
                <SourcePicker sources={sources} value={sourceId || null} onChange={(id) => setSourceId(id ?? "")} />
              </Field>
              <Field label="Tags" hint="Séparés par des virgules">
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="saas, b2b" />
              </Field>
              <Field label="Description / besoin identifié" className="sm:col-span-2">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </Field>
            </>
          )}
        </div>
        {!more && (
          <button type="button" onClick={() => setMore(true)} aria-expanded={false} className="-mt-2 inline-flex items-center gap-1 text-sm font-semibold text-violet-strong hover:underline">
            <ChevronDown size={14} /> Plus de champs <span className="font-normal text-muted">(source, tags, description)</span>
          </button>
        )}

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
            onOpen={openExisting}
            onComplete={(id) => void completeExisting(id)}
            completing={completing}
            onForce={() => submit(true)}
            pending={pending || !!completing}
          />
        )}
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

        {!candidates && (
          <div className="flex justify-end gap-2">
            <Button onClick={() => { keepDraft(null); onClose(); }}>Annuler</Button>
            <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
              {pending ? "Vérification…" : "Créer la fiche"}
            </Button>
          </div>
        )}
      </form>
  );
}
