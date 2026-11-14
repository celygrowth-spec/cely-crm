"use client";

// Parcours public : date → créneau → informations → confirmation.
// La saisie est conservée après une erreur ou un changement de créneau ; un créneau pris entre-temps
// propose des alternatives sans perdre le formulaire. Un double clic ne crée qu'un rendez-vous
// (clé d'idempotence par tentative).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/components/ui";
import { AddToCalendar, BookingSummary, PrivateLink } from "@/components/rdv/confirmation";
import { Brand, EventFacts } from "@/components/rdv/public-bits";
import { notifyHost } from "@/components/rdv/embed-frame";
import { SlotPicker, TimeZoneSelect } from "@/components/rdv/slot-picker";
import { browserTimeZone, formatRange, formatTimeShort, formatLongDate, isValidTimeZone, timeZoneLabel } from "@/lib/appointments/time";
import type { PublicBooking, PublicEvent, Question } from "@/lib/appointments/types";

type Form = { first_name: string; last_name: string; email: string; company_name: string; website: string; phone: string; answers: Record<string, string> };
const EMPTY: Form = { first_name: "", last_name: "", email: "", company_name: "", website: "", phone: "", answers: {} };

type BookResponse =
  | { status: "confirmed"; ref: string; booking: PublicBooking }
  | { status: "unavailable"; alternatives: string[] }
  | { status: "error"; message: string; retryable: boolean }
  | { error: string };

// changement d'étape : haut de page, et dans un site hôte, le calendrier intégré revient dans le champ de vision
function toTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  notifyHost("step");
}

const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");

export function BookingFlow({ event }: { event: PublicEvent }) {
  const [tz, setTz] = useState(event.timezone);
  const [slot, setSlot] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "form" | "done">("pick");
  const [form, setForm] = useState<Form>(EMPTY);
  // champ piège invisible (anti-robot) : un visiteur ne le voit ni ne le remplit
  const honeypot = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<string[] | null>(null);
  const [done, setDone] = useState<{ ref: string; booking: PublicBooking } | null>(null);
  const attemptKey = useRef<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // fuseau du visiteur détecté après le premier rendu (aucune différence serveur / navigateur)
  useEffect(() => {
    const t = browserTimeZone();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- valeur connue seulement dans le navigateur
    if (isValidTimeZone(t)) setTz(t);
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function choose(s: string) {
    setSlot(s);
    setAlternatives(null);
    setError(null);
    attemptKey.current = null; // nouveau créneau = nouvelle tentative
    setStep("form");
    toTop();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!slot || submitting) return;
    setSubmitting(true);
    setError(null);
    attemptKey.current ??= newKey();
    try {
      const res = await fetch("/api/rdv/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: event.slug,
          starts_at: slot,
          invitee: { first_name: form.first_name, last_name: form.last_name, email: form.email, company_name: form.company_name, website: form.website, phone: form.phone, timezone: tz },
          answers: form.answers,
          idempotency_key: attemptKey.current,
          fax: honeypot.current?.value || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({ error: "Réponse illisible du serveur" }))) as BookResponse;
      if ("status" in body && body.status === "confirmed") {
        setDone({ ref: body.ref, booking: body.booking });
        setStep("done");
        toTop();
        return;
      }
      attemptKey.current = null;
      if ("status" in body && body.status === "unavailable") {
        setAlternatives(body.alternatives);
        setError("Ce créneau vient d'être réservé. Choisissez un autre horaire : vos informations sont conservées.");
      } else {
        setError("status" in body && body.status === "error" ? body.message : "error" in body ? body.error : "La réservation a échoué.");
      }
    } catch {
      attemptKey.current = null;
      setError("Connexion impossible. Vérifiez votre réseau puis réessayez : rien n'a été confirmé.");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done" && done) {
    const manageUrl = `${window.location.origin}/rdv/gerer/${done.ref}`;
    return (
      <div className="fade-in mx-auto max-w-xl rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-6"><Brand name={event.display_name} /></div>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={28} aria-hidden />
          <div>
            <h1 className="font-display text-2xl font-bold text-ink" tabIndex={-1} ref={(n) => n?.focus()}>Rendez-vous confirmé</h1>
            <p className="mt-1 text-sm text-muted">{done.booking.event.name} avec {event.display_name}</p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-line p-4">
          <BookingSummary booking={done.booking} tz={tz} />
        </div>
        <div className="mt-5">
          <p className="mb-2 text-sm font-semibold text-ink">Ajouter à votre agenda</p>
          <AddToCalendar booking={done.booking} manageUrl={manageUrl} />
        </div>
        <p className="mt-5 rounded-lg bg-surface px-3 py-2 text-sm text-muted" data-invitation-note>
          Vous allez recevoir l&apos;invitation Google Agenda envoyée par {event.display_name}. Un report ou une annulation vous sera notifié de la même façon.
        </p>
        <div className="mt-5">
          <PrivateLink url={manageUrl} />
        </div>
      </div>
    );
  }

  const when = slot ? `${formatRange(slot, new Date(Date.parse(slot) + event.duration_min * 60_000).toISOString(), tz)}` : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm md:grid md:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-b border-line p-5 sm:p-6 md:border-r md:border-b-0">
        <Brand name={event.display_name} />
        <h1 className="mt-5 font-display text-2xl leading-tight font-bold text-ink">{event.name}</h1>
        <div className="mt-4">
          <EventFacts duration={event.duration_min} location={event.location_kind} locationDetail={event.location_detail} hasLink={event.has_meeting_link} when={step === "form" ? when : null} />
        </div>
        {step === "form" && (
          <p className="mt-2 text-xs text-muted">{timeZoneLabel(tz, slot ? new Date(slot) : undefined)}</p>
        )}
        {event.description && <p className="mt-4 text-sm leading-relaxed whitespace-pre-line text-muted">{event.description}</p>}
        {event.intro && <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed whitespace-pre-line text-muted">{event.intro}</p>}
      </aside>

      <section className="p-5 sm:p-6" aria-label="Réservation">
        {step === "pick" && (
          <div className="fade-in">
            <h2 className="mb-4 font-display text-lg font-bold text-ink">Choisissez une date et un horaire</h2>
            <SlotPicker slug={event.slug} tz={tz} onTzChange={setTz} horizonDays={event.horizon_days} selected={slot} onSelect={choose} />
          </div>
        )}

        {step === "form" && slot && (
          <form onSubmit={submit} className="fade-in max-w-xl space-y-4" noValidate={false}>
            <button type="button" onClick={() => setStep("pick")} className="inline-flex items-center gap-1 text-sm font-semibold text-violet-strong">
              <ArrowLeft size={16} /> Changer de créneau
            </button>
            <h2 className="font-display text-lg font-bold text-ink">Vos informations</h2>
            <input ref={honeypot} name="fax" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" />

            {error && (
              <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                {error}
                {alternatives && alternatives.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {alternatives.map((a) => (
                      <button key={a} type="button" onClick={() => choose(a)} className="rounded-lg border border-violet-line bg-white px-3 py-1.5 text-xs font-semibold text-violet-strong hover:border-violet">
                        {formatLongDate(a, tz).replace(/ \d{4}$/, "")} · {formatTimeShort(a, tz)}
                      </button>
                    ))}
                  </div>
                )}
                {alternatives && alternatives.length === 0 && (
                  <button type="button" onClick={() => setStep("pick")} className="mt-2 block font-semibold underline">Voir le calendrier</button>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Prénom" required autoComplete="given-name" value={form.first_name} onChange={(v) => setForm({ ...form, first_name: v })} max={100} />
              <TextField label="Nom" required autoComplete="family-name" value={form.last_name} onChange={(v) => setForm({ ...form, last_name: v })} max={100} />
            </div>
            <TextField label="Email" type="email" required autoComplete="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} max={254} />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Entreprise" autoComplete="organization" value={form.company_name} onChange={(v) => setForm({ ...form, company_name: v })} max={200} />
              <TextField label="Site web" type="url" inputMode="url" autoComplete="url" placeholder="exemple.fr" value={form.website} onChange={(v) => setForm({ ...form, website: v })} max={300} />
            </div>
            <TextField
              label="Téléphone"
              type="tel"
              autoComplete="tel"
              required={event.phone_required}
              value={form.phone}
              onChange={(v) => setForm({ ...form, phone: v })}
              max={50}
            />
            {event.questions.map((q) => (
              <QuestionField key={q.id} q={q} value={form.answers[q.id] ?? ""} onChange={(v) => setForm({ ...form, answers: { ...form.answers, [q.id]: v } })} />
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <TimeZoneSelect value={tz} onChange={setTz} id="rdv-tz-form" />
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-ink px-5 text-sm font-semibold text-white hover:bg-violet-strong disabled:opacity-60"
              >
                {submitting && <Loader2 size={16} className="animate-spin" aria-hidden />}
                {submitting ? "Confirmation…" : "Confirmer le rendez-vous"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function TextField({
  label, value, onChange, required, max, type = "text", ...rest
}: {
  label: string; value: string; onChange: (v: string) => void; required?: boolean; max: number; type?: string;
  autoComplete?: string; placeholder?: string; inputMode?: "url" | "email" | "tel" | "text";
}) {
  const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-muted">
        {label} {required ? <span className="text-danger" aria-hidden>*</span> : <span className="font-normal">(facultatif)</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full rounded-lg border border-line bg-white px-3 text-base text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none sm:text-sm"
        {...rest}
      />
    </div>
  );
}

function QuestionField({ q, value, onChange }: { q: Question; value: string; onChange: (v: string) => void }) {
  const id = `q-${q.id}`;
  const label = (
    <label htmlFor={id} className="mb-1 block text-xs font-semibold text-muted">
      {q.label} {q.required ? <span className="text-danger" aria-hidden>*</span> : <span className="font-normal">(facultatif)</span>}
    </label>
  );
  const cls = "w-full rounded-lg border border-line bg-white px-3 text-base text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none sm:text-sm";
  if (q.kind === "long") {
    return (
      <div>
        {label}
        <textarea id={id} value={value} required={q.required} maxLength={5000} rows={4} onChange={(e) => onChange(e.target.value)} className={cn(cls, "py-2")} />
      </div>
    );
  }
  if (q.kind === "choice") {
    return (
      <fieldset>
        <legend className="mb-1 block text-xs font-semibold text-muted">
          {q.label} {q.required ? <span className="text-danger" aria-hidden>*</span> : <span className="font-normal">(facultatif)</span>}
        </legend>
        <div className="flex flex-wrap gap-2">
          {(q.options ?? []).map((o) => (
            <label key={o} className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", value === o ? "border-violet bg-violet-soft text-ink" : "border-line text-ink hover:border-violet")}>
              <input type="radio" name={id} value={o} checked={value === o} required={q.required} onChange={() => onChange(o)} className="accent-violet-strong" />
              {o}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div>
      {label}
      <input id={id} value={value} required={q.required} maxLength={500} onChange={(e) => onChange(e.target.value)} className={cn(cls, "h-11")} />
    </div>
  );
}
