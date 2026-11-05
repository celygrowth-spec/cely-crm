"use client";

// Points de suivi d'un projet : chaque point est un rendez-vous du module Rendez-vous (création, report,
// annulation et lien Meet passent par le même service). Récapitulatif : brouillon → aperçu → publication.
import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { AlertTriangle, CalendarPlus, Eye, Link2, ListPlus, Plus, RefreshCw, Trash2, Video, X } from "lucide-react";
import {
  cancelMeetingAction, createMeetingAction, linkMeetingAction, publishRecapAction, rescheduleMeetingAction, restoreGoogleEventAction,
  saveRecapAction, syncGoogleNowAction, taskFromRecapAction, unlinkMeetingAction, updateMeetingAction,
} from "@/app/projets-actions";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { DEFAULT_TZ, formatLongDate, formatTimeShort, zonedToUtc } from "@/lib/appointments/time";
import type { AdminMeeting, Project, Recap, RecapAction, RecapLink } from "@/lib/projects/types";
import { RecapView } from "@/components/portal/meeting-detail";
import { VisibilityTag } from "../general";

type Type = { id: string; name: string; duration: number; meet: boolean };
type Person = { id: string; name: string; email: string | null };
type Linkable = { id: string; starts_at: string; first_name: string; last_name: string; event_snapshot: { name: string } };

function useAct() {
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  async function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, msg?: string) {
    setBusy(true);
    const r = await attempt(fn);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    if (msg) toast.success(msg);
    sync();
    return { data: r.data };
  }
  return { busy, act };
}

export function MeetingsView({ project, meetings, types, members, linkable, google }: {
  project: Project; meetings: AdminMeeting[]; types: Type[]; members: Person[]; linkable: Linkable[];
  google: { destination: boolean; syncedAt: string | null; error: string | null } | null;
}) {
  const { busy, act } = useAct();
  const [creating, setCreating] = useState(false);
  const [linkId, setLinkId] = useState("");
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setCreating(true)} disabled={!members.length || !types.length}><CalendarPlus size={15} /> Nouveau point</Button>
        {linkable.length > 0 && (
          <>
            <Select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="w-80" aria-label="Rendez-vous existant de la fiche">
              <option value="">Rattacher un rendez-vous existant de {project.company_name}…</option>
              {linkable.map((b) => <option key={b.id} value={b.id}>{formatLongDate(b.starts_at, DEFAULT_TZ).replace(/ \d{4}$/, "")} {formatTimeShort(b.starts_at, DEFAULT_TZ)} · {b.event_snapshot.name} · {b.first_name} {b.last_name}</option>)}
            </Select>
            <Button disabled={!linkId || busy} onClick={async () => { if (await act(() => linkMeetingAction(project.id, linkId, true), "Rendez-vous rattaché")) setLinkId(""); }}><Link2 size={14} /> Rattacher</Button>
          </>
        )}
      </div>
      {!members.length && <p className="text-sm text-warning">Ajoutez d&apos;abord un contact au projet (onglet Accès client).</p>}
      {!types.length && <p className="text-sm text-warning">Créez d&apos;abord un type de rendez-vous (Rendez-vous › Types), par exemple « Point de suivi » avec Google Meet.</p>}
      <p className="text-xs text-muted">
        Seuls les rendez-vous rattachés ici apparaissent sur le portail (jamais par ressemblance de nom ou de domaine). Date, statut et lien sont lus en direct depuis le rendez-vous : un report ou une annulation s&apos;y reflète aussitôt.
      </p>
      <GoogleSyncLine google={google} />

      {meetings.length === 0 ? <EmptyState title="Aucun point" description="Créez un point : le rendez-vous, l'événement Google Agenda et le lien Meet sont créés ensemble." /> : (
        <ul className="space-y-3">{meetings.map((m) => <MeetingCard key={m.id} m={m} projectId={project.id} />)}</ul>
      )}
      <CreateMeeting open={creating} onClose={() => setCreating(false)} projectId={project.id} types={types} members={members} />
    </div>
  );
}

function GoogleSyncLine({ google }: { google: { destination: boolean; syncedAt: string | null; error: string | null } | null }) {
  const { busy, act } = useAct();
  if (!google?.destination) return <p className="text-xs text-muted">Google Agenda non connecté : les points sont enregistrés dans Cely uniquement, sans lien Meet automatique.</p>;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
      Changements faits directement dans Google : {google.error ? <span className="text-danger">erreur ({google.error})</span> : google.syncedAt ? `vérifiés le ${formatDateTime(google.syncedAt)}` : "jamais vérifiés"}.
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(syncGoogleNowAction, "Vérification terminée")}><RefreshCw size={12} /> Vérifier maintenant</Button>
    </p>
  );
}

function MeetingCard({ m, projectId }: { m: AdminMeeting; projectId: string }) {
  const { busy, act } = useAct();
  const [open, setOpen] = useState<"none" | "edit" | "recap" | "move">("none");
  const b = m.booking;
  const cancelled = b.status === "cancelled";
  const [now] = useState(() => Date.now());
  const past = Date.parse(b.ends_at) < now;
  const [when, setWhen] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: DEFAULT_TZ, dateStyle: "short", timeStyle: "short" }).format(new Date(b.starts_at)).replace(" ", "T"));
  return (
    <li>
      <Card className={`p-4 ${cancelled ? "opacity-70" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-display text-base font-bold text-ink">{m.title ?? b.event_snapshot.name}</p>
          {cancelled ? <Badge>Annulé</Badge> : past ? <Badge>Passé</Badge> : <Badge tone="violet">À venir</Badge>}
          <VisibilityTag client={m.visible_to_client} />
          {m.recap?.status === "published" ? <Badge tone="success">Récapitulatif publié</Badge> : m.recap ? <Badge tone="warning">Brouillon</Badge> : null}
          <span className="ml-auto text-sm text-muted">{formatLongDate(b.starts_at, DEFAULT_TZ)} · {formatTimeShort(b.starts_at, DEFAULT_TZ)} – {formatTimeShort(b.ends_at, DEFAULT_TZ)} (Paris)</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Avec {b.first_name} {b.last_name}
          {b.meeting_url && !cancelled && <> · <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-violet-strong underline"><Video size={12} /> Lien de réunion</a></>}
        </p>
        {b.google_drift && !cancelled && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning">
            <AlertTriangle size={15} />
            {b.google_drift.kind === "moved" ? <>Déplacé dans Google Agenda au {formatLongDate(b.google_drift.start, DEFAULT_TZ)} {formatTimeShort(b.google_drift.start, DEFAULT_TZ)}. Cely et le portail affichent encore l&apos;horaire initial.</> : <>Supprimé dans Google Agenda, mais toujours prévu dans Cely et sur le portail.</>}
            <span className="ml-auto flex gap-1">
              {b.google_drift.kind === "moved" && <Button size="sm" disabled={busy} onClick={() => act(() => rescheduleMeetingAction(m.booking_id, (b.google_drift as { start: string }).start), "Horaire de Google appliqué")}>Appliquer cet horaire</Button>}
              {b.google_drift.kind === "deleted" && <Button size="sm" variant="danger" disabled={busy} onClick={() => act(() => cancelMeetingAction(m.booking_id, "Supprimé dans Google Agenda"), "Point annulé")}>Annuler le point</Button>}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => restoreGoogleEventAction(m.booking_id), "Google rétabli selon Cely")}>Rétablir dans Google</Button>
            </span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => setOpen(open === "recap" ? "none" : "recap")}>Récapitulatif</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(open === "edit" ? "none" : "edit")}>Ordre du jour et visibilité</Button>
          {!cancelled && !past && <Button size="sm" variant="ghost" onClick={() => setOpen(open === "move" ? "none" : "move")}>Reporter</Button>}
          {!cancelled && !past && <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm("Annuler ce point ? L'événement Google est supprimé ; le point reste visible comme annulé.") && act(() => cancelMeetingAction(m.booking_id, null), "Point annulé")}><X size={13} /> Annuler</Button>}
          <Button size="sm" variant="ghost" disabled={busy} title="Le rendez-vous reste dans Rendez-vous" onClick={() => confirm(m.recap ? "Détacher ce point du projet ? Son récapitulatif sera supprimé. Le rendez-vous reste intact." : "Détacher ce point du projet ? Le rendez-vous reste intact.") && act(() => unlinkMeetingAction(m.id), "Point détaché")}><Trash2 size={13} /></Button>
        </div>
        {open === "move" && (
          <div className="pop-in mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
            <Field label="Nouvel horaire (heure de Paris)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-56" /></Field>
            <Button variant="primary" disabled={busy} onClick={async () => {
              const [d, t] = when.split("T");
              if (await act(() => rescheduleMeetingAction(m.booking_id, zonedToUtc(d, t, DEFAULT_TZ).toISOString()), "Point reporté (agenda et portail à jour)")) setOpen("none");
            }}>Reporter</Button>
            <p className="w-full text-xs text-muted">L&apos;ancien horaire reste réservé jusqu&apos;à confirmation du nouveau ; Google Agenda est mis à jour avec le même lien de réunion.</p>
          </div>
        )}
        {open === "edit" && <EditMeeting m={m} onDone={() => setOpen("none")} />}
        {open === "recap" && <RecapEditor m={m} projectId={projectId} />}
        <Link href={`/projets/${projectId}/taches?point=${m.id}`} className="mt-2 inline-block text-xs font-semibold text-violet-strong underline">Tâches de ce point</Link>
      </Card>
    </li>
  );
}

function EditMeeting({ m, onDone }: { m: AdminMeeting; onDone: () => void }) {
  const { busy, act } = useAct();
  const [d, setD] = useState({ title: m.title ?? "", agenda: m.agenda ?? "", participants: m.participants ?? "", visible_to_client: m.visible_to_client });
  return (
    <div className="pop-in mt-3 space-y-2 rounded-lg border border-line p-3">
      <Field label="Titre affiché"><Input value={d.title} placeholder={m.booking.event_snapshot.name} maxLength={160} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <Field label="Ordre du jour (visible du client)"><Textarea value={d.agenda} maxLength={4000} onChange={(e) => setD({ ...d, agenda: e.target.value })} /></Field>
      <Field label="Participants"><Input value={d.participants} maxLength={500} placeholder="Ex. : Claire (Studio Démo), Célien (Cely Growth)" onChange={(e) => setD({ ...d, participants: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.visible_to_client} onChange={(e) => setD({ ...d, visible_to_client: e.target.checked })} /> Afficher ce point sur le portail</label>
      <Button variant="primary" disabled={busy} onClick={async () => { if (await act(() => updateMeetingAction(m.id, d), "Point enregistré")) onDone(); }}>Enregistrer</Button>
    </div>
  );
}

function RecapEditor({ m, projectId }: { m: AdminMeeting; projectId: string }) {
  const { busy, act } = useAct();
  const r = m.recap;
  const [d, setD] = useState({
    summary: r?.summary ?? "", decisions: r?.decisions ?? "", next_step: r?.next_step ?? "", internal_note: r?.internal_note ?? "",
    actions: (r?.actions ?? []) as RecapAction[], links: (r?.links ?? []) as RecapLink[],
  });
  const [preview, setPreview] = useState(false);
  const published = r?.status === "published";
  const save = () => act(() => saveRecapAction(m.id, { ...d, actions: d.actions.filter((a) => a.text.trim()), links: d.links.filter((l) => l.label.trim() || l.url.trim()) }), published ? "Récapitulatif mis à jour (déjà publié)" : "Brouillon enregistré");
  const view: Recap = { summary: d.summary || null, decisions: d.decisions || null, next_step: d.next_step || null, actions: d.actions.filter((a) => a.text.trim()), links: d.links.filter((l) => l.label && l.url) };
  return (
    <div className="pop-in mt-3 space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={published ? "success" : "warning"}>{published ? "Publié" : "Brouillon privé"}</Badge>
        {published && <span className="text-xs text-muted">Toute modification enregistrée est visible du client.</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPreview(!preview)}><Eye size={13} /> {preview ? "Modifier" : "Aperçu client"}</Button>
      </div>
      {preview ? (
        <div className="rounded-lg bg-surface p-4">
          {view.summary || view.decisions || view.next_step || view.actions.length ? <RecapView recap={view} /> : <p className="text-sm text-muted">Rien à afficher pour l&apos;instant.</p>}
          <p className="mt-3 text-xs text-muted">La note interne n&apos;apparaît jamais au client.</p>
        </div>
      ) : (
        <>
          <Field label="Résumé"><Textarea value={d.summary} maxLength={8000} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
          <Field label="Décisions"><Textarea value={d.decisions} maxLength={4000} onChange={(e) => setD({ ...d, decisions: e.target.value })} className="min-h-14" /></Field>
          <div>
            <p className="mb-1 font-label text-xs font-semibold text-muted">Actions à réaliser</p>
            {d.actions.map((a, i) => (
              <div key={i} className="mb-1 flex gap-2">
                <Input value={a.text} maxLength={300} onChange={(e) => setD({ ...d, actions: d.actions.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} aria-label={`Action ${i + 1}`} />
                {a.task_id ? (
                  <Link href={`/projets/${projectId}/taches?tache=${a.task_id}`} className="inline-flex shrink-0 items-center px-2 text-xs font-semibold text-violet-strong underline">Voir la tâche</Link>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy || !a.text.trim() || d.actions.slice(0, i).some((x) => !x.text.trim())} title="Créer une tâche client liée à ce point" onClick={async () => {
                    if (!(await save())) return;
                    const r = await act(() => taskFromRecapAction(m.id, i), "Tâche créée et liée au point");
                    if (r) setD((cur) => ({ ...cur, actions: cur.actions.map((x, j) => (j === i ? { ...x, task_id: r.data.task_id } : x)) }));
                  }}><ListPlus size={13} /> Tâche</Button>
                )}
                <Button size="sm" variant="ghost" aria-label="Retirer" onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}><Trash2 size={13} /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setD({ ...d, actions: [...d.actions, { text: "" }] })}><Plus size={13} /> Action</Button>
          </div>
          <Field label="Prochaine étape"><Textarea value={d.next_step} maxLength={2000} onChange={(e) => setD({ ...d, next_step: e.target.value })} className="min-h-12" /></Field>
          <div>
            <p className="mb-1 font-label text-xs font-semibold text-muted">Liens utiles</p>
            {d.links.map((l, i) => (
              <div key={i} className="mb-1 flex gap-2">
                <Input value={l.label} placeholder="Libellé" maxLength={120} className="w-48" onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label="Libellé du lien" />
                <Input value={l.url} placeholder="https://" maxLength={500} onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} aria-label="Adresse du lien" />
                <Button size="sm" variant="ghost" aria-label="Retirer" onClick={() => setD({ ...d, links: d.links.filter((_, j) => j !== i) })}><Trash2 size={13} /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setD({ ...d, links: [...d.links, { label: "", url: "" }] })}><Plus size={13} /> Lien</Button>
          </div>
          <div className="rounded-lg border border-dashed border-line p-2">
            <div className="mb-1 flex items-center justify-between"><span className="font-label text-xs font-semibold text-muted">Note interne</span><VisibilityTag client={false} /></div>
            <Textarea value={d.internal_note} maxLength={8000} onChange={(e) => setD({ ...d, internal_note: e.target.value })} className="min-h-12" aria-label="Note interne" />
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={save}>Enregistrer</Button>
        {!published ? (
          <Button variant="primary" disabled={busy} onClick={async () => { if (await save()) await act(() => publishRecapAction(m.id, true), "Récapitulatif publié sur le portail"); }}>Enregistrer et publier</Button>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => act(() => publishRecapAction(m.id, false), "Récapitulatif retiré du portail")}>Dépublier</Button>
        )}
      </div>
    </div>
  );
}

function CreateMeeting({ open, onClose, projectId, types, members }: { open: boolean; onClose: () => void; projectId: string; types: Type[]; members: Person[] }) {
  const { busy, act } = useAct();
  const [d, setD] = useState({ type_id: types[0]?.id ?? "", person_id: members[0]?.id ?? "", date: "", time: "10:00", duration: "", title: "", agenda: "", participants: "", visible: true });
  // une clé par tentative : un double clic ne crée qu'un point ; après un échec, une nouvelle tentative repart de zéro
  const [key, setKey] = useState(() => crypto.randomUUID());
  const type = types.find((t) => t.id === d.type_id);
  return (
    <Modal open={open} onClose={onClose} title="Nouveau point">
      {open && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type de rendez-vous"><Select value={d.type_id} onChange={(e) => setD({ ...d, type_id: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <Field label="Contact"><Select value={d.person_id} onChange={(e) => setD({ ...d, person_id: e.target.value })}>{members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" required value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
            <Field label="Heure (Paris)"><Input type="time" required value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} /></Field>
            <Field label="Durée (min)"><Input type="number" min={5} max={480} placeholder={String(type?.duration ?? 30)} value={d.duration} onChange={(e) => setD({ ...d, duration: e.target.value })} /></Field>
            <Field label="Titre affiché"><Input value={d.title} maxLength={160} placeholder={type?.name} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
          </div>
          <Field label="Ordre du jour (visible du client)"><Textarea value={d.agenda} maxLength={4000} onChange={(e) => setD({ ...d, agenda: e.target.value })} className="min-h-14" /></Field>
          <Field label="Participants"><Input value={d.participants} maxLength={500} onChange={(e) => setD({ ...d, participants: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.visible} onChange={(e) => setD({ ...d, visible: e.target.checked })} /> Afficher sur le portail</label>
          <p className="text-xs text-muted">{type?.meet ? "Un lien de réunion sera fourni (lien fixe du type, ou Google Meet si l'agenda est connecté)." : "Ce type n'a pas de lien de réunion : activez Google Meet dans le type pour en générer un."} Aucune invitation n&apos;est envoyée par email.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button variant="primary" disabled={busy || !d.date || !d.type_id || !d.person_id} onClick={async () => {
              const r = await act(() => createMeetingAction(projectId, {
                type_id: d.type_id, person_id: d.person_id, starts_at: zonedToUtc(d.date, d.time, DEFAULT_TZ).toISOString(),
                duration_min: d.duration ? Number(d.duration) : null, title: d.title, agenda: d.agenda, participants: d.participants, visible: d.visible, idempotency_key: key,
              }), "Point créé");
              setKey(crypto.randomUUID());
              if (r) onClose();
            }}>{busy ? "Création…" : "Créer le point"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
