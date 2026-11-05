"use client";

// Gestion d'un rendez-vous par le visiteur : consulter, annuler (confirmation explicite, motif
// facultatif) ou reporter (nouveau créneau vérifié avant que l'ancien soit libéré).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarX2, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { AddToCalendar, BookingSummary } from "@/components/rdv/confirmation";
import { Brand } from "@/components/rdv/public-bits";
import { SlotPicker } from "@/components/rdv/slot-picker";
import { browserTimeZone, formatLongDate, formatTimeShort, isValidTimeZone } from "@/lib/appointments/time";
import type { PublicBooking } from "@/lib/appointments/types";

export function ManageView({ booking, refToken, manageUrl, past }: { booking: PublicBooking; refToken: string; manageUrl: string; past: boolean }) {
  const router = useRouter();
  const [tz, setTz] = useState(booking.invitee_timezone);
  const [mode, setMode] = useState<"view" | "cancel" | "reschedule">("view");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = browserTimeZone();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- valeur connue seulement dans le navigateur
    if (isValidTimeZone(t) && t !== booking.invitee_timezone) setTz(t);
  }, [booking.invitee_timezone]);

  const cancelled = booking.status === "cancelled";

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rdv/gerer/${refToken}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { status?: string; error?: string; message?: string; alternatives?: string[] };
      return { ok: res.ok, ...j };
    } catch {
      return { ok: false, error: "Connexion impossible. Rien n'a été modifié ; réessayez." };
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const r = await post("cancel", { reason });
    if (r.ok && r.status === "cancelled") {
      setNotice("Votre rendez-vous est annulé. Le créneau a été libéré.");
      setMode("view");
      router.refresh();
    } else setError(r.error ?? r.message ?? "L'annulation n'a pas abouti.");
  }

  async function reschedule(slot: string) {
    const r = await post("reschedule", { starts_at: slot });
    if (r.ok && r.status === "rescheduled") {
      setNotice("Votre rendez-vous est reporté. Pensez à mettre à jour votre agenda (nouveau fichier .ics ci-dessous).");
      setMode("view");
      setAlternatives([]);
      router.refresh();
    } else if (r.status === "unavailable") {
      setAlternatives(r.alternatives ?? []);
      setError("Ce créneau vient d'être réservé. Choisissez-en un autre : votre rendez-vous actuel est conservé.");
    } else setError(r.error ?? r.message ?? "Le report n'a pas abouti. Votre rendez-vous actuel est conservé.");
  }

  return (
    <div className="fade-in mx-auto max-w-2xl rounded-2xl border border-line bg-white p-5 shadow-sm sm:p-8">
      <Brand name={booking.display_name} />
      <h1 className="mt-6 font-display text-2xl font-bold text-ink">
        {cancelled ? "Rendez-vous annulé" : `Bonjour ${booking.first_name}`}
      </h1>
      <p className="mt-1 text-sm text-muted">{booking.event.name} avec {booking.display_name}</p>

      {notice && (
        <p role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {notice}
        </p>
      )}

      <div className={`mt-5 rounded-xl border border-line p-4 ${cancelled ? "opacity-60" : ""}`}>
        <BookingSummary booking={booking} tz={tz} />
        {cancelled && <p className="mt-3 text-sm font-semibold text-danger">Annulé{booking.cancelled_by === "owner" ? " par l'organisateur" : ""}.</p>}
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
          {alternatives.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {alternatives.map((a) => (
                <button key={a} type="button" disabled={busy} onClick={() => reschedule(a)} className="rounded-lg border border-violet-line bg-white px-3 py-1.5 text-xs font-semibold text-violet-strong hover:border-violet">
                  {formatLongDate(a, tz).replace(/ \d{4}$/, "")} · {formatTimeShort(a, tz)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!cancelled && !past && mode === "view" && (
        <>
          <div className="mt-5">
            <p className="mb-2 text-sm font-semibold text-ink">Ajouter à votre agenda</p>
            <AddToCalendar booking={booking} manageUrl={manageUrl} />
          </div>
          <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
            {booking.event_active && (
              <button type="button" onClick={() => { setMode("reschedule"); setError(null); }} className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-violet-strong">
                <RefreshCw size={15} /> Reporter
              </button>
            )}
            <button type="button" onClick={() => { setMode("cancel"); setError(null); }} className="inline-flex h-10 items-center gap-2 rounded-lg border border-danger/30 px-4 text-sm font-semibold text-danger hover:bg-danger/5">
              <CalendarX2 size={15} /> Annuler le rendez-vous
            </button>
          </div>
        </>
      )}

      {!cancelled && past && <p className="mt-5 text-sm text-muted">Ce rendez-vous est passé : il ne peut plus être modifié en ligne.</p>}

      {mode === "cancel" && (
        <div className="pop-in mt-6 rounded-xl border border-danger/20 bg-danger/5 p-4">
          <h2 className="font-display text-base font-bold text-ink">Confirmer l&apos;annulation ?</h2>
          <label htmlFor="reason" className="mt-3 mb-1 block text-xs font-semibold text-muted">Motif (facultatif)</label>
          <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-base focus:border-violet focus:outline-none sm:text-sm" />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={cancel} className="inline-flex h-10 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60">
              {busy && <Loader2 size={15} className="animate-spin" />} Oui, annuler
            </button>
            <button type="button" disabled={busy} onClick={() => setMode("view")} className="h-10 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink">
              Garder mon rendez-vous
            </button>
          </div>
        </div>
      )}

      {mode === "reschedule" && (
        <div className="pop-in mt-6 border-t border-line pt-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-bold text-ink">Choisissez un nouvel horaire</h2>
            <button type="button" onClick={() => setMode("view")} className="text-sm font-semibold text-muted hover:text-ink">Fermer</button>
          </div>
          <p className="mb-4 text-xs text-muted">Votre rendez-vous actuel reste réservé tant que le nouveau n&apos;est pas confirmé.</p>
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> Report en cours…</p>
          ) : (
            <SlotPicker slug={booking.slug} tz={tz} onTzChange={setTz} horizonDays={365} selected={null} onSelect={reschedule} manageRef={refToken} confirmLabel="Reporter ici" />
          )}
        </div>
      )}
    </div>
  );
}
