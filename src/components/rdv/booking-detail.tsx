"use client";

// Détail rapide d'un rendez-vous (ouvert par ?rdv=<id> depuis la vue d'ensemble, l'agenda ou la liste) :
// réponses, fiche CRM, note interne, report, annulation, qualification, historique.
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarX2, Check, Copy, ExternalLink, Link2, RefreshCw, UserX } from "lucide-react";
import {
  cancelBookingAction, createFicheFromBookingAction, linkBookingAction, manageLinkAction, rescheduleBookingAction, setNoteAction, setOutcomeAction,
} from "@/app/rendez-vous-actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, Input, Modal, Skeleton, Textarea, cn } from "@/components/ui";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { SearchResult } from "@/lib/crm/types";
import { formatDateTime } from "@/lib/format";
import { DEFAULT_TZ, formatLongDate, formatRange, formatTimeShort, timeZoneLabel } from "@/lib/appointments/time";
import { DISPLAY_STATUS_LABELS, LOCATION_LABELS, type Booking, type DisplayStatus } from "@/lib/appointments/types";
import { SlotPicker } from "./slot-picker";
import { BookingReminders } from "./booking-reminders";
import type { BookingDetail as BookingDetailData } from "@/lib/appointments/owner";

export const STATUS_TONE: Record<DisplayStatus, "violet" | "warning" | "success" | "danger" | "neutral"> = {
  a_venir: "violet",
  a_renseigner: "warning",
  done: "success",
  no_show: "danger",
  cancelled: "neutral",
  pending: "neutral",
};

export function StatusBadge({ s }: { s: DisplayStatus }) {
  return <Badge tone={STATUS_TONE[s]}>{DISPLAY_STATUS_LABELS[s]}</Badge>;
}

const EVENT_LABELS: Record<string, string> = {
  created: "Réservation reçue",
  confirmed: "Confirmé",
  failed: "Échec de la confirmation (créneau libéré)",
  expired: "Retenue expirée (créneau libéré)",
  cancelled: "Annulé",
  rescheduled: "Reporté",
  reschedule_failed: "Report non abouti (horaire conservé)",
  outcome: "Qualification",
  note: "Note interne modifiée",
  crm_linked: "Rattaché à une fiche",
  crm_created: "Fiche créée",
  crm_to_link: "À rattacher",
  reminders: "Rappels activés / désactivés",
  reminders_reapplied: "Règles de rappel réappliquées",
};
const ACTORS = { invitee: "le contact", owner: "vous", system: "automatique" } as const;

/** Monte la fenêtre de détail en fonction du paramètre ?rdv= de l'URL. */
export function BookingDetailHost() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const id = params.get("rdv");
  const close = () => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("rdv");
    router.replace(sp.size ? `${pathname}?${sp.toString()}` : pathname, { scroll: false });
  };
  return (
    <Modal open={!!id} onClose={close} title="Rendez-vous" wide>
      {id && <BookingDetail key={id} id={id} onClose={close} />}
    </Modal>
  );
}

/** Lien qui ouvre le détail sans quitter l'écran. */
export function useOpenBooking() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("rdv", id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };
}

function BookingDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const sync = useSync();
  const { openCompany } = useCrm();
  const q = useQuery({
    queryKey: ["appt-booking", id],
    queryFn: ({ signal }) => apiGet<BookingDetailData | null>(`/api/rendez-vous/bookings/${id}`, signal),
  });
  const [mode, setMode] = useState<"view" | "cancel" | "reschedule">("view");
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now()); // instant d'ouverture du détail

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["appt-booking", id] });
    sync(["appt-company"]);
  }

  async function act<T extends { ok: boolean }>(fn: () => Promise<T>, success?: string) {
    setBusy(true);
    const r = await attempt(fn);
    setBusy(false);
    if (!r.ok) {
      toast.error("error" in r ? (r.error as string) : "Action impossible");
      return null;
    }
    if (success) toast.success(success);
    await refresh();
    return r;
  }

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (q.isError) return <p className="text-sm text-danger">{q.error.message}</p>;
  if (!q.data) return <p className="text-sm text-muted">Rendez-vous introuvable.</p>;
  const { booking: b, events, reminders, remindersOff, reminderSettings } = q.data;
  const future = Date.parse(b.starts_at) > now;
  const started = !future;
  const otherTz = b.invitee_timezone !== DEFAULT_TZ;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl font-bold text-ink">{b.first_name} {b.last_name}</h3>
          <StatusBadge s={b.display_status} />
          {b.crm_status === "to_link" && b.status === "confirmed" && <Badge tone="warning">À rattacher</Badge>}
        </div>
        <p className="mt-1 text-sm font-semibold text-ink">{b.event_snapshot.name} · {formatRange(b.starts_at, b.ends_at, DEFAULT_TZ)}</p>
        {otherTz && <p className="text-xs text-muted">Pour le contact : {formatRange(b.starts_at, b.ends_at, b.invitee_timezone)} ({timeZoneLabel(b.invitee_timezone, new Date(b.starts_at))})</p>}
        <p className="mt-1 text-sm text-muted">
          {LOCATION_LABELS[b.event_snapshot.location_kind]}
          {b.meeting_url && b.status === "confirmed" && (
            <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold text-violet-strong underline">
              Rejoindre <ExternalLink size={12} />
            </a>
          )}
          {b.event_snapshot.location_kind === "phone" && b.phone && <span className="ml-2">{b.phone}</span>}
        </p>
        {b.calendar_target && (b.calendar_out_of_sync || b.calendar_sync_error) && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Google Agenda pas encore à jour{b.calendar_sync_error ? ` : ${b.calendar_sync_error}` : ""}. Reprise automatique, ou depuis « Connexion agenda ».
          </p>
        )}
        {b.google_drift && b.status === "confirmed" && (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {b.google_drift.kind === "moved"
              ? `Déplacé directement dans Google Agenda au ${formatLongDate(b.google_drift.start, DEFAULT_TZ)} ${formatTimeShort(b.google_drift.start, DEFAULT_TZ)}. Cely garde l'horaire ci-dessus : reportez-le ici, ou rétablissez Google depuis « Connexion agenda ».`
              : "Supprimé directement dans Google Agenda, mais toujours prévu dans Cely : annulez-le ici ou rétablissez Google."}
          </p>
        )}
        {b.status === "cancelled" && (
          <p className="mt-2 text-sm text-muted">
            Annulé {b.cancelled_by === "invitee" ? "par le contact" : "par vous"} le {formatDateTime(b.cancelled_at)}
            {b.cancel_reason && <> — « {b.cancel_reason} »</>}
          </p>
        )}
      </div>

      {/* Actions */}
      {b.status === "confirmed" && mode === "view" && (
        <div className="flex flex-wrap gap-2">
          {future && (
            <>
              <Button onClick={() => setMode("reschedule")} disabled={busy}><RefreshCw size={14} /> Reporter</Button>
              <Button variant="danger" onClick={() => setMode("cancel")} disabled={busy}><CalendarX2 size={14} /> Annuler</Button>
              <CopyManageLink id={b.id} />
            </>
          )}
          {started && (
            <>
              <Button variant={b.outcome === "done" ? "primary" : "secondary"} disabled={busy} onClick={() => act(() => setOutcomeAction(b.id, "done"), "Marqué comme réalisé")}>
                <Check size={14} /> Réalisé
              </Button>
              <Button variant={b.outcome === "no_show" ? "primary" : "secondary"} disabled={busy} onClick={() => act(() => setOutcomeAction(b.id, "no_show"), "Marqué comme absent")}>
                <UserX size={14} /> No-show
              </Button>
              {b.outcome && <Button variant="ghost" disabled={busy} onClick={() => act(() => setOutcomeAction(b.id, null))}>Effacer</Button>}
            </>
          )}
        </div>
      )}
      {mode === "cancel" && <CancelBox busy={busy} onBack={() => setMode("view")} onConfirm={async (reason) => { if (await act(() => cancelBookingAction(b.id, reason), "Rendez-vous annulé")) setMode("view"); }} />}
      {mode === "reschedule" && <RescheduleBox booking={b} onBack={() => setMode("view")} onDone={async () => { setMode("view"); await refresh(); }} />}

      {/* CRM */}
      <section className="rounded-xl border border-line p-4">
        <h4 className="mb-2 font-label text-xs font-semibold tracking-wide text-muted uppercase">Contact et fiche CRM</h4>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Email : </dt><dd className="inline"><a href={`mailto:${b.email}`} className="text-violet-strong underline">{b.email}</a></dd></div>
          {b.phone && <div><dt className="inline text-muted">Téléphone : </dt><dd className="inline">{b.phone}</dd></div>}
          {b.company_name && <div><dt className="inline text-muted">Entreprise indiquée : </dt><dd className="inline">{b.company_name}</dd></div>}
          {b.website && <div><dt className="inline text-muted">Site : </dt><dd className="inline">{b.website}</dd></div>}
        </dl>
        <div className="mt-3 border-t border-line pt-3">
          {b.company_id ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Fiche : <strong>{b.crm_company_name}</strong></span>
              {b.crm_status === "created" && <Badge tone="violet">créée par la réservation</Badge>}
              <Button size="sm" onClick={() => { onClose(); openCompany(b.company_id!, { name: b.crm_company_name ?? "" }); }}>Ouvrir la fiche</Button>
            </div>
          ) : (
            <LinkCrm booking={b} busy={busy} act={act} />
          )}
        </div>
      </section>

      {b.answers.length > 0 && (
        <section>
          <h4 className="mb-2 font-label text-xs font-semibold tracking-wide text-muted uppercase">Réponses au formulaire</h4>
          <dl className="space-y-2 text-sm">
            {b.answers.map((a) => (
              <div key={a.id}><dt className="font-semibold text-ink">{a.label}</dt><dd className="whitespace-pre-line text-muted">{a.value}</dd></div>
            ))}
          </dl>
        </section>
      )}

      <NoteBox key={b.internal_note ?? ""} booking={b} busy={busy} act={act} />

      {(b.status === "confirmed" || reminders.length > 0) && (
        <BookingReminders booking={b} reminders={reminders} off={remindersOff} settings={reminderSettings} onChanged={refresh} now={now} />
      )}

      <section>
        <h4 className="mb-2 font-label text-xs font-semibold tracking-wide text-muted uppercase">Historique</h4>
        <ol className="space-y-1 text-xs text-muted">
          {events.map((e) => (
            <li key={e.id}>
              <span className="font-semibold text-ink">{EVENT_LABELS[e.kind] ?? e.kind}</span> · {formatDateTime(e.created_at)} · {ACTORS[e.actor]}
              {e.kind === "rescheduled" && typeof e.data.from === "string" && <> — ancien horaire {formatLongDate(e.data.from, DEFAULT_TZ)} {formatTimeShort(e.data.from, DEFAULT_TZ)}</>}
              {typeof e.data.reason === "string" && e.data.reason && <> — {e.data.reason}</>}
              {e.kind === "outcome" && <> — {e.data.outcome === "done" ? "réalisé" : e.data.outcome === "no_show" ? "no-show" : "effacé"}</>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

type Act = <T extends { ok: boolean }>(fn: () => Promise<T>, success?: string) => Promise<T | null>;

function CopyManageLink({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={async () => {
        const r = await attempt(() => manageLinkAction(id));
        if (!r.ok) return toast.error(r.error);
        try {
          await navigator.clipboard.writeText(r.data.url);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast.message(r.data.url);
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Lien copié" : "Lien privé du contact"}
    </Button>
  );
}

function CancelBox({ busy, onBack, onConfirm }: { busy: boolean; onBack: () => void; onConfirm: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="pop-in rounded-xl border border-danger/20 bg-danger/5 p-4">
      <p className="text-sm font-semibold text-ink">Annuler ce rendez-vous ?</p>
      <p className="mt-1 text-xs text-muted">Le créneau est libéré et l&apos;événement Google supprimé. Aucun email n&apos;est envoyé automatiquement pour l&apos;instant : prévenez le contact.</p>
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif (facultatif)" className="mt-2" maxLength={1000} />
      <div className="mt-2 flex gap-2">
        <Button variant="danger" disabled={busy} onClick={() => onConfirm(reason.trim() || null)}>Confirmer l&apos;annulation</Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>Retour</Button>
      </div>
    </div>
  );
}

function RescheduleBox({ booking, onBack, onDone }: { booking: Booking; onBack: () => void; onDone: () => void }) {
  const [ref, setRef] = useState<string | null>(null);
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void attempt(() => manageLinkAction(booking.id)).then((r) => {
      if (!live) return;
      if (r.ok) setRef(r.data.ref);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [booking.id]);

  async function pick(slot: string) {
    setBusy(true);
    setError(null);
    const r = await attempt(() => rescheduleBookingAction(booking.id, slot));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.data.status === "rescheduled") {
      toast.success(`Reporté au ${formatLongDate(slot, DEFAULT_TZ)} à ${formatTimeShort(slot, DEFAULT_TZ)}`);
      onDone();
    } else if (r.data.status === "unavailable") setError("Ce créneau vient d'être pris. Choisissez-en un autre ; l'horaire actuel est conservé.");
    else setError(r.data.message);
  }

  return (
    <div className="pop-in rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Nouvel horaire (l&apos;actuel reste réservé jusqu&apos;à confirmation)</p>
        <Button size="sm" variant="ghost" onClick={onBack}>Fermer</Button>
      </div>
      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      {busy ? <p className="text-sm text-muted">Report en cours…</p> : ref ? (
        <SlotPicker slug={booking.event_snapshot.slug} tz={tz} onTzChange={setTz} horizonDays={365} selected={null} onSelect={pick} manageRef={ref} confirmLabel="Reporter ici" />
      ) : !error && <Skeleton className="h-64 w-full" />}
    </div>
  );
}

function NoteBox({ booking, busy, act }: { booking: Booking; busy: boolean; act: Act }) {
  const [note, setNote] = useState(booking.internal_note ?? "");
  const dirty = note !== (booking.internal_note ?? "");
  return (
    <section>
      <label htmlFor="appt-note" className="mb-2 block font-label text-xs font-semibold tracking-wide text-muted uppercase">Note interne</label>
      <Textarea id="appt-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} placeholder="Visible uniquement par vous" />
      {dirty && <Button size="sm" className="mt-2" disabled={busy} onClick={() => act(() => setNoteAction(booking.id, note), "Note enregistrée")}>Enregistrer la note</Button>}
    </section>
  );
}

function LinkCrm({ booking: b, busy, act }: { booking: Booking; busy: boolean; act: Act }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [newName, setNewName] = useState(b.company_name ?? `${b.first_name} ${b.last_name}`);
  const [dups, setDups] = useState<{ company_id: string; name: string }[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["search", debounced, false],
    queryFn: ({ signal }) => apiGet<SearchResult[]>(`/api/search?q=${encodeURIComponent(debounced)}`, signal),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });

  async function create(force: boolean) {
    const r = await act(() => createFicheFromBookingAction(b.id, newName, force));
    if (r && "data" in r) {
      const d = r.data as { status: string; candidates?: { company_id: string; name: string }[] };
      if (d.status === "duplicates") setDups(d.candidates ?? []);
      else toast.success("Fiche créée et rattachée");
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="flex items-center gap-1.5 font-semibold text-warning"><Link2 size={14} /> À rattacher : aucune fiche certaine.</p>
      {b.crm_candidates.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted">Suggestions (à vérifier, rien n&apos;est fusionné automatiquement) :</p>
          <ul className="space-y-1">
            {b.crm_candidates.map((c) => (
              <li key={c.company_id} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{c.name}</span>
                <span className="text-xs text-muted">{c.reasons.join(" · ")}</span>
                <Button size="sm" disabled={busy} onClick={() => act(() => linkBookingAction(b.id, c.company_id, null), "Rattaché")}>Rattacher</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher une autre fiche…" aria-label="Chercher une fiche" />
        {debounced.length >= 2 && (
          <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line">
            {(search.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-surface">
                <span className="truncate">{r.name} {r.matched && <span className="text-xs text-muted">· {r.matched}</span>}</span>
                <Button size="sm" disabled={busy} onClick={() => act(() => linkBookingAction(b.id, r.id, null), "Rattaché")}>Rattacher</Button>
              </li>
            ))}
            {search.data?.length === 0 && <li className="px-3 py-1.5 text-muted">Aucune fiche.</li>}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="new-fiche" className="mb-1 block text-xs font-semibold text-muted">Ou créer une fiche</label>
          <Input id="new-fiche" value={newName} onChange={(e) => { setNewName(e.target.value); setDups(null); }} />
        </div>
        <Button disabled={busy || !newName.trim()} onClick={() => create(false)}>Créer et rattacher</Button>
      </div>
      {dups && (
        <div className={cn("rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-warning")}>
          Fiches proches : {dups.map((d) => d.name).join(", ")}. Rattachez-en une ci-dessus, ou
          <button type="button" className="ml-1 font-semibold underline" onClick={() => create(true)}>créer quand même</button>.
        </div>
      )}
    </div>
  );
}
