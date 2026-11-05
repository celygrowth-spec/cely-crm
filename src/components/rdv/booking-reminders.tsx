"use client";

// Rappels d'un rendez-vous : échéances prévues, désactivation, modification locale, ajout, annulation,
// réapplication explicite des règles actuelles (avec aperçu). Aucun envoi ici.
import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, X } from "lucide-react";
import {
  addReminderAction, cancelReminderAction, reapplyRulesAction, reapplyRulesPreviewAction, setBookingRemindersOffAction, updateReminderAction,
} from "@/app/rendez-vous-actions";
import { Badge, Button, Input, Select, Textarea } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { offsetLabel, type OffsetUnit, type Reminder } from "@/lib/appointments/reminders";
import { DEFAULT_TZ, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import type { Booking } from "@/lib/appointments/types";
import { MailStatusNotice } from "./reminder-rules";

type Settings = { paused: boolean; mailConnectedAt: string | null };

function statusBadge(r: Reminder, s: Settings, off: boolean) {
  switch (r.status) {
    case "sent": return <Badge tone="success">Envoyé</Badge>;
    case "failed": return <Badge tone="danger">Échec d&apos;envoi</Badge>;
    case "cancelled": return <Badge>Annulé</Badge>;
    case "superseded": return <Badge>Remplacé</Badge>;
  }
  if (off) return <Badge>Désactivé</Badge>;
  if (!s.mailConnectedAt) return <Badge tone="warning">Programmé · envoi non connecté</Badge>;
  if (s.paused) return <Badge tone="warning">Suspendu</Badge>;
  return <Badge tone="violet">Programmé</Badge>;
}

type Form = { offset_value: number; offset_unit: OffsetUnit; subject: string; body: string };

export function BookingReminders({ booking, reminders, off, settings, onChanged, now }: {
  booking: Booking; reminders: Reminder[]; off: boolean; settings: Settings; onChanged: () => Promise<void>; now: number;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form>({ offset_value: 2, offset_unit: "hours", subject: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ removed: { send_at: string; subject: string; customized: boolean }[]; added: { send_at: string; subject: string }[]; skipped_past: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const upcoming = booking.status === "confirmed" && Date.parse(booking.starts_at) > now;
  const current = reminders.filter((r) => r.status === "scheduled");
  const history = reminders.filter((r) => r.status !== "scheduled");

  async function act<T extends { ok: boolean }>(fn: () => Promise<T>, msg?: string) {
    setBusy(true);
    const r = await attempt(fn);
    setBusy(false);
    if (!r.ok) {
      toast.error("error" in r ? String(r.error) : "Action impossible");
      return null;
    }
    if (msg) toast.success(msg);
    await onChanged();
    return r;
  }

  function editForm(onSave: () => void) {
    return (
      <div className="pop-in mt-2 space-y-2 rounded-lg border border-violet-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="number" min={1} value={form.offset_value} onChange={(e) => setForm({ ...form, offset_value: Number(e.target.value) })} className="w-20" aria-label="Délai" />
          <Select value={form.offset_unit} onChange={(e) => setForm({ ...form, offset_unit: e.target.value as OffsetUnit })} className="w-32" aria-label="Unité">
            <option value="days">jours</option><option value="hours">heures</option><option value="minutes">minutes</option>
          </Select>
          <span className="text-sm text-muted">avant le rendez-vous</span>
        </div>
        <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Objet" maxLength={200} aria-label="Objet" />
        <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Message ({{prenom}}, {{date}}…)" maxLength={5000} rows={4} aria-label="Message" />
        <p className="text-xs text-muted">Modification propre à ce rendez-vous : le modèle du type n&apos;est pas changé.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={busy || !form.subject.trim() || !form.body.trim()} onClick={onSave}>Enregistrer</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Annuler</Button>
        </div>
      </div>
    );
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="font-label text-xs font-semibold tracking-wide text-muted uppercase">Rappels</h4>
        {upcoming && (
          <label className="ml-auto flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={!off} disabled={busy} onChange={(e) => act(() => setBookingRemindersOffAction(booking.id, !e.target.checked), e.target.checked ? "Rappels réactivés" : "Rappels désactivés pour ce rendez-vous")} />
            Rappels actifs pour ce rendez-vous
          </label>
        )}
      </div>
      {upcoming && <div className="mb-2"><MailStatusNotice mailConnectedAt={settings.mailConnectedAt} paused={settings.paused} /></div>}
      {current.length === 0 && <p className="text-sm text-muted">Aucun rappel programmé.</p>}
      <ul className="space-y-1.5">
        {current.map((r) => (
          <li key={r.id} className="rounded-lg border border-line p-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{formatLongDate(r.send_at, DEFAULT_TZ).replace(/ \d{4}$/, "")} · {formatTimeShort(r.send_at, DEFAULT_TZ)}</span>
              <span className="text-xs text-muted">{offsetLabel(r.offset_value, r.offset_unit)}</span>
              {r.origin === "custom" ? <Badge tone="neutral">spécifique</Badge> : r.customized && <Badge tone="neutral">personnalisé</Badge>}
              {statusBadge(r, settings, off)}
              {upcoming && Date.parse(r.send_at) > now && (
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" aria-label="Modifier le rappel" onClick={() => { setForm({ offset_value: r.offset_value, offset_unit: r.offset_unit, subject: r.subject, body: r.body }); setEditing(r.id); }}><Pencil size={13} /></Button>
                  <Button size="sm" variant="ghost" aria-label="Annuler le rappel" disabled={busy} onClick={() => act(() => cancelReminderAction(r.id), "Rappel annulé")}><X size={13} /></Button>
                </span>
              )}
            </div>
            <p className="truncate text-xs text-muted">{r.subject}</p>
            {editing === r.id && editForm(() => act(() => updateReminderAction(r.id, form), "Rappel modifié").then((x) => x && setEditing(null)))}
          </li>
        ))}
      </ul>
      {upcoming && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => { setForm({ offset_value: 2, offset_unit: "hours", subject: "Rappel : {{type}} à {{heure}}", body: "Bonjour {{prenom}},\n\n" }); setEditing("new"); }}><Plus size={13} /> Rappel spécifique</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
            const r = await attempt(() => reapplyRulesPreviewAction(booking.id));
            if (!r.ok) return toast.error(r.error);
            setPreview(r.data);
          }}>Réappliquer les règles actuelles…</Button>
        </div>
      )}
      {editing === "new" && editForm(() => act(() => addReminderAction(booking.id, form), "Rappel ajouté").then((x) => x && setEditing(null)))}
      {preview && (
        <div className="pop-in mt-2 rounded-lg border border-line p-3 text-sm">
          <p className="font-semibold text-ink">Aperçu de la réapplication</p>
          <p className="mt-1 text-xs text-muted">Remplacés : {preview.removed.length ? preview.removed.map((x) => `${formatTimeShort(x.send_at, DEFAULT_TZ)} ${formatLongDate(x.send_at, DEFAULT_TZ).replace(/ \d{4}$/, "")}${x.customized ? " (personnalisé)" : ""}`).join(" · ") : "aucun"}</p>
          <p className="text-xs text-muted">Nouveaux : {preview.added.length ? preview.added.map((x) => `${x.subject} (${formatLongDate(x.send_at, DEFAULT_TZ).replace(/ \d{4}$/, "")} ${formatTimeShort(x.send_at, DEFAULT_TZ)})`).join(" · ") : "aucun"}</p>
          {preview.skipped_past > 0 && <p className="text-xs text-muted">{preview.skipped_past} échéance(s) déjà dépassée(s) : non créée(s).</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act(() => reapplyRulesAction(booking.id), "Règles réappliquées").then((x) => x && setPreview(null))}>Confirmer</Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Annuler</Button>
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="mt-2">
          <button type="button" className="text-xs font-semibold text-muted underline" onClick={() => setShowHistory(!showHistory)}>{showHistory ? "Masquer" : "Afficher"} l&apos;historique des rappels ({history.length})</button>
          {showHistory && (
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {history.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  {statusBadge(r, settings, off)} {formatLongDate(r.send_at, DEFAULT_TZ).replace(/ \d{4}$/, "")} {formatTimeShort(r.send_at, DEFAULT_TZ)} · {r.subject}
                  {r.status_reason && <span>— {r.status_reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
