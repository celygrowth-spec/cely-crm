"use client";

// Mode Focus : traiter les actions dues à la chaîne.
// Gauche : file de travail. Centre : l'action et son message. Droite : le contexte.
// Copier ou ouvrir LinkedIn ne valide jamais rien : seul le bouton de validation enregistre.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, Ban, Check, ChevronDown, Copy, ExternalLink, Globe, Inbox, Keyboard, Mail, Phone, SkipForward, X,
} from "lucide-react";
import {
  completeStepAction, recordReplyAction, saveDraftAction, setOutcomeAction, skipStepAction, undoActionAction, updateParticipantsAction,
} from "@/app/prospection-actions";
import { useCrm } from "@/components/app-shell";
import { LinkedinGlyph, StepIcon } from "@/components/prospection/bits";
import { Badge, Button, Input, Modal, Select, Spinner, Textarea, cn } from "@/components/ui";
import type { Person } from "@/lib/crm/types";
import { addDaysISO, CHANNEL_LABELS, formatDate, formatDateTime, KIND_LABELS, localInputToISO, nowLocalInput, personName, relativeDay, todayISO } from "@/lib/format";
import type { FocusItem } from "@/lib/prospection/service";
import { STEP_META, remainingTokens, variableLabel } from "@/lib/prospection/steps";
import { contextFor, preparedMessage } from "@/lib/prospection/workspace";

type Outcome = "done" | "skipped" | "postponed" | "replied";
type Edit = { subject: string; body: string; personId: string; doneAt: string | null; key: string };

const href = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

export function FocusSession({ items, campaignName }: { items: FocusItem[]; campaignName: string | null }) {
  const router = useRouter();
  const [queue] = useState(items); // file figée pour la session
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const today = todayISO();

  const item = queue[index] ?? null;
  const processed = Object.keys(results).length;
  const remaining = queue.filter((q) => !results[q.participant.id]);

  const editFor = useCallback(
    (it: FocusItem): Edit => {
      const existing = edits[it.participant.id];
      if (existing) return existing;
      const person = it.people.find((x) => x.id === it.participant.person_id) ?? null;
      const msg = preparedMessage(it.step, it.draft, contextFor(it.participant, person));
      return { subject: msg.subject, body: msg.body, personId: it.participant.person_id ?? "", doneAt: null, key: crypto.randomUUID() };
    },
    [edits],
  );
  const edit = item ? editFor(item) : null;
  const setEdit = (patch: Partial<Edit>) => item && setEdits((e) => ({ ...e, [item.participant.id]: { ...editFor(item), ...patch } }));

  const goNext = useCallback(
    (from = index) => {
      const nextIdx = queue.findIndex((q, i) => i > from && !results[q.participant.id]);
      const any = queue.findIndex((q) => !results[q.participant.id]);
      setIndex(nextIdx >= 0 ? nextIdx : any >= 0 ? any : from);
    },
    [queue, results, index],
  );

  // enregistrement automatique du brouillon (≠ envoi)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved">("idle");
  function onTextChange(patch: Partial<Edit>) {
    if (!item) return;
    setEdit(patch);
    const next = { ...editFor(item), ...patch };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setDraftState("saving");
    const it = item;
    draftTimer.current = setTimeout(async () => {
      const r = await saveDraftAction(it.participant.id, it.step.position, STEP_META[it.step.step_type].hasSubject ? next.subject : null, next.body);
      setDraftState(r.ok ? "saved" : "idle");
      if (!r.ok) toast.error(r.error);
    }, 700);
  }

  const missing = edit ? [...new Set(remainingTokens(`${edit.subject} ${edit.body}`))] : [];
  const meta = item ? STEP_META[item.step.step_type] : null;
  const person = item ? item.people.find((x) => x.id === (edit?.personId || item.participant.person_id)) ?? null : null;
  const blocked = !!meta && ((meta.hasMessage && missing.length > 0) || (meta.messageRequired && !edit?.body.trim()));

  function finish(id: string, outcome: Outcome) {
    setResults((r) => ({ ...r, [id]: outcome }));
  }

  async function validate() {
    if (!item || !edit || !meta || busy || blocked) return;
    setBusy(true);
    const r = await completeStepAction({
      participantId: item.participant.id,
      content: meta.hasMessage ? edit.body : edit.body.trim() || null,
      subject: meta.hasSubject ? edit.subject : null,
      doneAt: edit.doneAt ? localInputToISO(edit.doneAt) : null,
      personId: edit.personId || null,
      idempotencyKey: edit.key,
    });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    const id = item.participant.id;
    const company = item.participant.company.name;
    finish(id, "done");
    toast.success(
      `${meta.doneLabel} · ${company}` + (r.data.finished ? " · séquence terminée" : r.data.next_due_date ? ` · étape suivante ${relativeDay(r.data.next_due_date).toLowerCase()}` : ""),
      {
        duration: 10000,
        action: {
          label: "Annuler",
          onClick: async () => {
            const u = await undoActionAction(r.data.action_id);
            if (!u.ok) return toast.error(u.error);
            setResults((x) => { const n = { ...x }; delete n[id]; return n; });
            setEdits((e) => ({ ...e, [id]: { ...e[id], key: crypto.randomUUID() } }));
            toast.success("Action annulée : l'étape est de nouveau à faire");
          },
        },
      },
    );
    goNext();
  }

  async function skip() {
    if (!item || busy) return;
    if (!confirm(`Ignorer l'étape « ${item.step.name} » ? Le suivi continue avec l'étape suivante (ce n'est pas un arrêt).`)) return;
    setBusy(true);
    const r = await skipStepAction(item.participant.id, `skip:${editFor(item).key}`);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    const id = item.participant.id;
    finish(id, "skipped");
    toast.success("Étape ignorée", {
      duration: 10000,
      action: {
        label: "Annuler",
        onClick: async () => {
          const u = await undoActionAction(r.data.action_id);
          if (!u.ok) return toast.error(u.error);
          setResults((x) => { const n = { ...x }; delete n[id]; return n; });
        },
      },
    });
    goNext();
  }

  async function postpone(days: number | string) {
    if (!item || busy) return;
    const due = typeof days === "number" ? addDaysISO(today, days) : days;
    setBusy(true);
    const r = await updateParticipantsAction([item.participant.id], "postpone", { due });
    setBusy(false);
    if (!r.ok || r.data.errors.length) return toast.error(r.ok ? r.data.errors[0] : r.error);
    finish(item.participant.id, "postponed");
    toast.success(`Reporté au ${formatDate(due)} — l'étape n'est pas réalisée`);
    goNext();
  }

  // raccourcis : jamais de validation au clavier, et rien pendant la saisie
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); goNext(); }
      else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
      else if (k === "c") { e.preventDefault(); copy(edit?.body ?? ""); }
      else if (k === "l" && person?.linkedin_url) { e.preventDefault(); window.open(href(person.linkedin_url), "_blank", "noopener"); }
      else if (k === "e") { e.preventDefault(); bodyRef.current?.focus(); }
      else if (k === "r") { e.preventDefault(); setReplyOpen(true); }
      else if (e.key === "?") { e.preventDefault(); setHelp(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function copy(text: string, what = "Message") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copié — rien n'est marqué comme envoyé`);
    } catch {
      // presse-papiers refusé par le navigateur : le texte est sélectionné pour un Cmd+C manuel
      const el = what === "Objet" ? document.querySelector<HTMLInputElement>('input[aria-label="Objet"]') : bodyRef.current;
      el?.focus();
      el?.select();
      toast.error("Copie automatique refusée par le navigateur : le texte est sélectionné, faites Cmd+C.");
    }
  }

  if (!queue.length) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <p className="font-display text-2xl font-extrabold">Rien à traiter</p>
        <p className="mt-2 text-sm text-muted">Aucune action due {campaignName ? `dans « ${campaignName} »` : "dans vos campagnes actives"}. Les actions des campagnes en pause ne sont pas proposées.</p>
        <Link href="/prospection/aujourdhui" className="mt-4 inline-block font-semibold text-violet-strong">← Retour à Aujourd&apos;hui</Link>
      </div>
    );
  }

  const allDone = remaining.length === 0;

  return (
    <div className="-mx-4 -mt-5 -mb-24 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden md:-mx-8 md:-mt-7 md:-mb-10 md:h-dvh">
      {/* En-tête de session */}
      <div className="flex items-center gap-3 border-b border-line bg-white px-4 py-2">
        <Link href="/prospection/aujourdhui" className="flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft size={15} /> Quitter</Link>
        <p className="font-display text-base font-bold">Session de prospection{campaignName ? ` · ${campaignName}` : ""}</p>
        <div className="ml-4 flex min-w-40 flex-1 items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
            <div className="h-full rounded-full bg-violet transition-all" style={{ width: `${(processed / queue.length) * 100}%` }} />
          </div>
          <span className="font-label text-xs tabular-nums">{processed} / {queue.length}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setHelp(true)}><Keyboard size={14} /> Raccourcis</Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* File de travail */}
        <aside className="hidden min-h-0 overflow-y-auto border-r border-line bg-surface/50 lg:block">
          <ol>
            {queue.map((q, i) => {
              const r = results[q.participant.id];
              const p = q.people.find((x) => x.id === q.participant.person_id);
              const late = q.participant.next_due_date! < today;
              return (
                <li key={q.participant.id}>
                  <button
                    onClick={() => setIndex(i)}
                    className={cn("flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left", i === index ? "bg-white" : "hover:bg-white/70", r && "opacity-55")}
                  >
                    <StepIcon type={q.step.step_type} size={11} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm font-semibold", r && "line-through")}>{q.participant.company.name}</span>
                      <span className="block truncate text-xs text-muted">{p ? personName(p) : "Personne à choisir"} · {q.step.name}</span>
                    </span>
                    {r ? (
                      <Badge tone={r === "done" ? "success" : "neutral"}>{r === "done" ? "Fait" : r === "skipped" ? "Ignoré" : r === "postponed" ? "Reporté" : "Réponse"}</Badge>
                    ) : late ? (
                      <Badge tone="danger">{relativeDay(q.participant.next_due_date)}</Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* Action */}
        <main className="min-h-0 overflow-y-auto px-4 py-4 md:px-6">
          {allDone ? (
            <div className="mx-auto max-w-md py-12 text-center">
              <Check className="mx-auto text-success" size={36} />
              <p className="mt-2 font-display text-2xl font-extrabold">Session terminée</p>
              <p className="mt-1 text-sm text-muted">
                {Object.values(results).filter((r) => r === "done").length} réalisée(s) · {Object.values(results).filter((r) => r === "skipped").length} ignorée(s) ·{" "}
                {Object.values(results).filter((r) => r === "postponed").length} reportée(s) · {Object.values(results).filter((r) => r === "replied").length} réponse(s)
              </p>
              <Button className="mt-4" variant="primary" onClick={() => { router.push("/prospection/aujourdhui"); router.refresh(); }}>Retour à Aujourd&apos;hui</Button>
            </div>
          ) : item && edit && meta ? (
            <div className="mx-auto max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <StepIcon type={item.step.step_type} size={16} />
                <div>
                  <p className="font-display text-xl font-extrabold">{meta.label} · {item.participant.company.name}</p>
                  <p className="text-xs text-muted">
                    Étape {item.step.position}/{item.stepCount} « {item.step.name} » · {item.campaign.name} ·{" "}
                    <span className={item.participant.next_due_date! < today ? "font-semibold text-danger" : ""}>échéance {relativeDay(item.participant.next_due_date).toLowerCase()}</span>
                  </p>
                </div>
                {results[item.participant.id] && <Badge tone="success" className="ml-auto">Déjà traité dans cette session</Badge>}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                <span className="text-xs text-muted">Destinataire</span>
                <Select value={edit.personId} onChange={(e) => setEdit({ personId: e.target.value })} className="h-8 w-auto max-w-64 text-sm" aria-label="Personne ciblée">
                  <option value="">— Choisir —</option>
                  {item.people.map((x) => <option key={x.id} value={x.id}>{personName(x)}{x.title ? ` · ${x.title}` : ""}</option>)}
                </Select>
                <div className="ml-auto flex flex-wrap gap-1">
                  {person?.linkedin_url && (
                    <a href={href(person.linkedin_url)} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold text-[#0a66c2] hover:bg-[#e8f1fb]">
                      <LinkedinGlyph size={12} /> Ouvrir LinkedIn
                    </a>
                  )}
                  {person?.email && meta.channel === "email" && (
                    <a
                      href={`mailto:${person.email}?subject=${encodeURIComponent(edit.subject)}&body=${encodeURIComponent(edit.body)}`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold hover:bg-violet-soft"
                    >
                      <Mail size={12} /> Brouillon email
                    </a>
                  )}
                  {person?.phone && <a href={`tel:${person.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold hover:bg-emerald-50"><Phone size={12} /> {person.phone}</a>}
                  {item.participant.company.website && (
                    <a href={href(item.participant.company.website)} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-semibold hover:bg-surface"><Globe size={12} /> Site</a>
                  )}
                </div>
              </div>
              {meta.needs && !person?.[meta.needs === "linkedin" ? "linkedin_url" : meta.needs === "email" ? "email" : "phone"] && (
                <p className="mt-2 flex items-center gap-1 text-xs text-warning"><AlertTriangle size={12} /> {meta.needs === "linkedin" ? "Profil LinkedIn" : meta.needs === "email" ? "Email" : "Téléphone"} absent pour ce destinataire.</p>
              )}

              {item.step.instructions && (
                <div className="mt-3 rounded-lg border-l-2 border-amber-300 bg-amber-50/70 px-3 py-2 text-sm"><span className="font-semibold">Consigne : </span>{item.step.instructions}</div>
              )}

              <div className="mt-3 space-y-2">
                {meta.hasSubject && (
                  <div className="flex gap-1">
                    <Input value={edit.subject} onChange={(e) => onTextChange({ subject: e.target.value })} placeholder="Objet" aria-label="Objet" />
                    <Button onClick={() => copy(edit.subject, "Objet")} title="Copier l'objet"><Copy size={14} /></Button>
                  </div>
                )}
                <Textarea
                  ref={bodyRef}
                  value={edit.body}
                  onChange={(e) => onTextChange({ body: e.target.value })}
                  rows={meta.hasMessage ? 11 : 4}
                  placeholder={meta.hasMessage ? (item.step.step_type === "linkedin_invite" ? "Note d'invitation (facultative)" : "Message") : "Notes (facultatif) : ce qui a été fait, compte rendu d'appel…"}
                  aria-label={meta.hasMessage ? "Message personnalisé" : "Notes"}
                />
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {missing.length > 0 ? (
                    <span className="flex items-center gap-1 font-semibold text-danger"><AlertTriangle size={12} /> Variable à remplacer : {missing.map((m) => `${variableLabel(m)} ({{${m}}})`).join(", ")}</span>
                  ) : meta.messageRequired && !edit.body.trim() ? (
                    <span className="text-danger">Le message est vide.</span>
                  ) : (
                    <span className="text-muted">{item.draft || draftState !== "idle" ? "Version personnalisée pour ce prospect" : "Modèle de la campagne"}</span>
                  )}
                  <span className="ml-auto text-muted">{draftState === "saving" ? "Enregistrement du brouillon…" : draftState === "saved" ? "Brouillon enregistré" : ""} · {edit.body.length} car.</span>
                </div>
              </div>

              <div className="sticky bottom-0 mt-4 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-white px-1 py-3">
                {meta.hasMessage && <Button onClick={() => copy(edit.body)}><Copy size={14} /> Copier le message</Button>}
                <Button variant="primary" className="h-10 px-5 text-base" disabled={busy || blocked} onClick={validate}>
                  {busy ? <Spinner /> : <Check size={16} />} {meta.doneLabel}
                </Button>
                <PostponeMenu onPick={postpone} disabled={busy} />
                <Button variant="ghost" onClick={skip} disabled={busy}><SkipForward size={14} /> Ignorer l&apos;étape</Button>
                <Button variant="ghost" onClick={() => setReplyOpen(true)} disabled={busy}><Inbox size={14} /> Réponse reçue</Button>
                <details className="ml-auto text-xs">
                  <summary className="cursor-pointer text-muted">Réalisé à une autre date ?</summary>
                  <Input type="datetime-local" value={edit.doneAt ?? nowLocalInput()} onChange={(e) => setEdit({ doneAt: e.target.value })} className="mt-1 h-8 w-52" />
                </details>
              </div>
              <p className="text-[11px] text-muted">Copier ou ouvrir LinkedIn n&apos;enregistre rien. Le bouton « {meta.doneLabel} » enregistre l&apos;action dans l&apos;historique et calcule la prochaine échéance depuis maintenant.</p>
            </div>
          ) : null}
        </main>

        {/* Contexte */}
        {item && !allDone && <ContextPanel item={item} />}
      </div>

      {item && !allDone && (
        <ReplyDialog
          open={replyOpen}
          onClose={() => setReplyOpen(false)}
          item={item}
          personId={edit?.personId || null}
          onDone={() => {
            finish(item.participant.id, "replied");
            setReplyOpen(false);
            goNext();
          }}
        />
      )}

      <Modal open={help} onClose={() => setHelp(false)} title="Raccourcis clavier">
        <ul className="space-y-1.5 text-sm">
          {[["J ou ↓", "Action suivante"], ["K ou ↑", "Action précédente"], ["C", "Copier le message"], ["L", "Ouvrir le profil LinkedIn"], ["E", "Modifier le message"], ["R", "Enregistrer une réponse"], ["?", "Afficher cette aide"]].map(([k, l]) => (
            <li key={k} className="flex justify-between"><span>{l}</span><kbd className="rounded border border-line bg-surface px-1.5 font-label text-xs">{k}</kbd></li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Les raccourcis sont inactifs pendant la saisie. Aucun raccourci ne valide une action : la validation se fait uniquement au clic.</p>
      </Modal>
    </div>
  );
}

function PostponeMenu({ onPick, disabled }: { onPick: (d: number | string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDaysISO(todayISO(), 3));
  return (
    <div className="relative">
      <Button variant="ghost" onClick={() => setOpen((o) => !o)} disabled={disabled}>Reporter <ChevronDown size={13} /></Button>
      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" aria-label="Fermer" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full z-30 mb-1 w-56 rounded-lg border border-line bg-white p-1.5 shadow-xl">
            {[[1, "Demain"], [2, "Dans 2 jours"], [7, "Dans une semaine"]].map(([d, l]) => (
              <button key={d} onClick={() => { setOpen(false); onPick(d as number); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-violet-soft">{l}</button>
            ))}
            <div className="mt-1 flex gap-1 border-t border-line pt-1.5">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 text-xs" />
              <Button size="sm" onClick={() => { setOpen(false); onPick(date); }}>OK</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ContextPanel({ item }: { item: FocusItem }) {
  const { openCompany } = useCrm();
  const c = item.participant.company;
  const notes = item.recent.filter((r) => r.kind === "note");
  const exchanges = item.recent.filter((r) => r.kind !== "note");
  return (
    <aside className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface/40 px-4 py-4 lg:block">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-display text-lg font-bold">{c.name}</p>
          {c.domain_norm && <p className="text-xs text-muted">{c.domain_norm}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => openCompany(c.id)} title="Ouvrir la fiche"><ExternalLink size={13} /></Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {item.pipelineLabel ? <Badge tone="violet">{item.pipelineLabel}</Badge> : <Badge>Hors pipeline</Badge>}
        {c.do_not_contact && <Badge tone="danger"><Ban size={10} /> Ne plus contacter</Badge>}
        {c.last_interaction_at && <Badge>Dernier échange {formatDate(c.last_interaction_at)}</Badge>}
      </div>

      <h3 className="mt-4 mb-1 font-label text-[11px] font-bold text-muted uppercase">Contacts</h3>
      <ul className="space-y-1.5">
        {item.people.map((p: Person) => (
          <li key={p.id} className={cn("rounded-lg border bg-white px-2 py-1.5 text-sm", p.id === item.participant.person_id ? "border-violet" : "border-line")}>
            <p className="font-semibold">{personName(p)}{p.is_primary && <span className="ml-1 text-[10px] text-violet-strong">principal</span>}</p>
            {p.title && <p className="text-xs text-muted">{p.title}</p>}
            <p className="flex flex-wrap gap-x-2 text-xs text-muted">
              {p.email && <span>{p.email}</span>}
              {p.phone && <span>{p.phone}</span>}
              {p.linkedin_url && <a className="text-[#0a66c2]" href={href(p.linkedin_url)} target="_blank" rel="noreferrer noopener">LinkedIn ↗</a>}
            </p>
          </li>
        ))}
        {!item.people.length && <li className="text-sm text-danger">Aucune personne sur la fiche.</li>}
      </ul>

      {item.otherCampaigns.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 font-label text-[11px] font-bold text-muted uppercase">Autres campagnes actives</h3>
          <ul className="space-y-1 text-xs">
            {item.otherCampaigns.map((o, i) => (
              <li key={i} className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-amber-900">
                <AlertTriangle size={11} /> {o.campaign_name} · étape {o.current_step}{o.next_due_date ? ` · ${relativeDay(o.next_due_date).toLowerCase()}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}

      {notes.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 font-label text-[11px] font-bold text-muted uppercase">Notes</h3>
          <ul className="space-y-1">
            {notes.slice(0, 3).map((n) => <li key={n.id} className="rounded-md border-l-2 border-amber-300 bg-white px-2 py-1 text-xs whitespace-pre-wrap">{n.content}</li>)}
          </ul>
        </>
      )}

      <h3 className="mt-4 mb-1 font-label text-[11px] font-bold text-muted uppercase">Derniers échanges</h3>
      <ol className="space-y-1.5">
        {exchanges.map((r) => (
          <li key={r.id} className="text-xs">
            <p className="text-muted">
              <span className={cn("font-semibold", r.kind === "message_in" ? "text-success" : "text-ink")}>{KIND_LABELS[r.kind]}</span>
              {r.channel && ` · ${CHANNEL_LABELS[r.channel]}`} · {formatDateTime(r.occurred_at)}
            </p>
            {r.content && <p className="line-clamp-3 whitespace-pre-wrap">{r.content}</p>}
          </li>
        ))}
        {!exchanges.length && <li className="text-xs text-muted">Aucun échange enregistré.</li>}
      </ol>
    </aside>
  );
}

function ReplyDialog({ open, onClose, item, personId, onDone }: { open: boolean; onClose: () => void; item: FocusItem; personId: string | null; onDone: () => void }) {
  const { pipelines } = useCrm();
  const [text, setText] = useState("");
  const [at, setAt] = useState(nowLocalInput());
  const [next, setNext] = useState<"none" | "interested" | "meeting" | "not_interested">("none");
  const [stage, setStage] = useState("");
  const [busy, setBusy] = useState(false);
  const stageOptions = useMemo(() => pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, label: `${p.name} › ${s.name}` }))), [pipelines]);

  async function save() {
    setBusy(true);
    const r = await recordReplyAction(item.participant.id, text, localInputToISO(at), personId);
    if (!r.ok) {
      setBusy(false);
      return toast.error(r.error);
    }
    if (next !== "none") {
      const o = await setOutcomeAction(item.participant.id, next, next === "interested" ? stage || null : null);
      if (!o.ok) toast.error(`Réponse enregistrée, mais le résultat a échoué : ${o.error}`);
    }
    setBusy(false);
    toast.success(`Réponse enregistrée : relances de ${item.participant.company.name} suspendues${r.data.paused_followups > 1 ? ` (${r.data.paused_followups} suivis)` : ""}`);
    setText("");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title={`Réponse de ${item.participant.company.name}`}>
      <div className="space-y-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Collez la réponse reçue" />
        <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-56" aria-label="Reçue le" />
        <div>
          <p className="mb-1 font-label text-xs font-semibold text-muted">Résultat (facultatif)</p>
          <div className="flex flex-wrap gap-1">
            {([["none", "À décider plus tard"], ["interested", "Intéressé"], ["meeting", "RDV obtenu"], ["not_interested", "Pas intéressé"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setNext(k)} className={cn("rounded-md border px-2 py-1 text-xs", next === k ? "border-violet bg-violet-soft font-semibold" : "border-line")}>{l}</button>
            ))}
          </div>
          {next === "interested" && (
            <Select value={stage} onChange={(e) => setStage(e.target.value)} className="mt-2 h-8 text-xs" aria-label="Pipeline">
              <option value="">Sans pipeline pour l&apos;instant</option>
              {stageOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          )}
        </div>
        <p className="text-xs text-muted">Les relances de cette entreprise sont suspendues dans toutes ses campagnes, pour tous ses contacts.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}><X size={13} /> Annuler</Button>
          <Button variant="primary" disabled={busy || !text.trim()} onClick={save}>Enregistrer la réponse</Button>
        </div>
      </div>
    </Modal>
  );
}
