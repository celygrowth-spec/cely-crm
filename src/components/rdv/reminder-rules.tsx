"use client";

// Section « Rappels » d'un type de rendez-vous : règles globales (délais exacts), aperçu avec un
// rendez-vous réel, duplication, suppression, et application explicite aux rendez-vous existants.
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Copy, Eye, Plus, Trash2 } from "lucide-react";
import {
  previewReminderAction, reapplyRulesManyAction, saveReminderRulesAction, typeReapplyPreviewAction,
} from "@/app/rendez-vous-actions";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { DEFAULT_TZ, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import { EXAMPLE_RULES, VARIABLES, offsetLabel, unknownVariables, type OffsetUnit, type ReminderRule } from "@/lib/appointments/reminders";

export function MailStatusNotice({ mailConnectedAt, paused }: { mailConnectedAt: string | null; paused: boolean }) {
  if (!mailConnectedAt) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span><strong>Envoi non connecté.</strong> Les rappels sont calculés et programmés, mais aucun email ne part tant que le module Mail n&apos;est pas raccordé. Au raccordement, seules les échéances futures seront envoyées.</span>
      </p>
    );
  }
  if (paused) return <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning"><strong>Rappels suspendus.</strong> Aucune échéance n&apos;est transmise pendant la suspension ; celles dépassées ne seront pas rattrapées.</p>;
  return null;
}

type Draft = ReminderRule & { key: string };
let seq = 0;
const withKey = (r: ReminderRule): Draft => ({ ...r, key: r.id ?? `n${++seq}` });

export function ReminderRules({ typeId, initialEnabled, initialRules, bookings, mailConnectedAt, paused }: {
  typeId: string;
  initialEnabled: boolean;
  initialRules: ReminderRule[];
  bookings: { id: string; label: string }[];
  mailConnectedAt: string | null;
  paused: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [rules, setRules] = useState<Draft[]>(() => initialRules.map(withKey));
  const [saved, setSaved] = useState(() => JSON.stringify({ e: initialEnabled, r: initialRules }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; subject: string; body: string; unknown: string[] } | null>(null);
  const [previewBooking, setPreviewBooking] = useState<string>(bookings[0]?.id ?? "");
  const [reapply, setReapply] = useState<{ id: string; starts_at: string; name: string; customized: boolean }[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const strip = (r: Draft) => ({ id: r.id, enabled: r.enabled, offset_value: r.offset_value, offset_unit: r.offset_unit, subject: r.subject, body: r.body });
  const dirty = JSON.stringify({ e: enabled, r: rules.map(strip) }) !== saved;
  const update = (key: string, patch: Partial<ReminderRule>) => setRules(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    const r = await attempt(() => saveReminderRulesAction(typeId, enabled, rules.map(strip)));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Rappels enregistrés : ils s'appliquent aux nouvelles réservations");
    const fresh = r.data.map(withKey);
    setRules(fresh);
    setSaved(JSON.stringify({ e: enabled, r: fresh.map(strip) }));
  }

  async function showPreview(r: Draft) {
    const res = await attempt(() => previewReminderAction(typeId, r.subject, r.body, previewBooking || null));
    if (!res.ok) return toast.error(res.error);
    setPreview({ key: r.key, ...res.data });
  }

  async function openReapply() {
    const res = await attempt(() => typeReapplyPreviewAction(typeId));
    if (!res.ok) return toast.error(res.error);
    setReapply(res.data);
    setSelected(res.data.filter((b) => !b.customized).map((b) => b.id));
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-ink">Rappels</h2>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Activer les rappels pour ce type
        </label>
      </div>
      <MailStatusNotice mailConnectedAt={mailConnectedAt} paused={paused} />
      <p className="text-xs text-muted">
        Délais exacts avant le début du rendez-vous (« 24 heures avant », pas « la veille à 9 h »). Une échéance déjà dépassée au moment de la
        réservation n&apos;est pas programmée. Modifier ces règles ne change pas les rendez-vous déjà réservés, sauf application explicite ci-dessous.
      </p>

      {rules.map((r, i) => {
        const unknown = [...unknownVariables(r.subject), ...unknownVariables(r.body)];
        return (
          <div key={r.key} className={`space-y-2 rounded-lg border border-line p-3 ${r.enabled && enabled ? "" : "bg-surface"}`}>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex h-9 items-center gap-1.5 text-sm"><input type="checkbox" checked={r.enabled} onChange={(e) => update(r.key, { enabled: e.target.checked })} /> Rappel {i + 1}</label>
              <Field label="Délai"><Input type="number" min={1} max={10000} value={r.offset_value} onChange={(e) => update(r.key, { offset_value: Number(e.target.value) })} className="w-24" /></Field>
              <Field label="Unité">
                <Select value={r.offset_unit} onChange={(e) => update(r.key, { offset_unit: e.target.value as OffsetUnit })} className="w-32">
                  <option value="days">jours</option><option value="hours">heures</option><option value="minutes">minutes</option>
                </Select>
              </Field>
              <span className="pb-2 text-sm text-muted">{offsetLabel(r.offset_value, r.offset_unit)}</span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => showPreview(r)}><Eye size={13} /> Aperçu</Button>
                <Button size="sm" variant="ghost" disabled={rules.length >= 10} onClick={() => setRules([...rules.slice(0, i + 1), withKey({ ...strip(r), id: undefined }), ...rules.slice(i + 1)])} aria-label="Dupliquer"><Copy size={13} /></Button>
                <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((x) => x.key !== r.key))} aria-label="Supprimer"><Trash2 size={13} /></Button>
              </div>
            </div>
            <Field label="Objet"><Input value={r.subject} maxLength={200} onChange={(e) => update(r.key, { subject: e.target.value })} /></Field>
            <Field label="Message"><Textarea value={r.body} maxLength={5000} rows={5} onChange={(e) => update(r.key, { body: e.target.value })} /></Field>
            {unknown.length > 0 && <p className="text-xs text-danger">Variable inconnue : {unknown.map((u) => `{{${u}}}`).join(", ")}</p>}
            {preview?.key === r.key && (
              <div className="pop-in rounded-lg border border-violet-line bg-violet-soft/40 p-3 text-sm">
                <p className="mb-1 font-label text-xs text-muted">Aperçu{previewBooking ? "" : " (données d'exemple)"}</p>
                <p className="font-semibold text-ink">{preview.subject}</p>
                <p className="mt-1 whitespace-pre-line text-ink">{preview.body}</p>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={rules.length >= 10} onClick={() => setRules([...rules, withKey({ enabled: true, offset_value: 24, offset_unit: "hours", subject: "Rappel : {{type}} le {{date}}", body: "Bonjour {{prenom}},\n\n" })])}>
          <Plus size={13} /> Ajouter un rappel
        </Button>
        {rules.length === 0 && <Button size="sm" variant="ghost" onClick={() => setRules(EXAMPLE_RULES.map(withKey))}>Partir de l&apos;exemple (2 jours, 24 h, 1 h)</Button>}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          Aperçu avec
          <Select value={previewBooking} onChange={(e) => setPreviewBooking(e.target.value)} className="h-8 w-64 text-xs">
            <option value="">Données d&apos;exemple</option>
            {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </Select>
        </span>
      </div>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-semibold">Variables disponibles</summary>
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {VARIABLES.map((v) => <li key={v.key}><code className="rounded bg-surface px-1">{`{{${v.key}}}`}</code> {v.label}</li>)}
        </ul>
      </details>

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer les rappels"}</Button>
        <Button disabled={busy || dirty} onClick={openReapply} title={dirty ? "Enregistrez d'abord" : undefined}>Appliquer aux rendez-vous à venir…</Button>
      </div>

      {reapply && (
        <div className="pop-in space-y-2 rounded-lg border border-line p-3 text-sm">
          <p className="font-semibold text-ink">Appliquer les règles actuelles aux rendez-vous à venir</p>
          {reapply.length === 0 ? <p className="text-muted">Aucun rendez-vous à venir pour ce type.</p> : (
            <>
              <p className="text-xs text-muted">Les rappels programmés des rendez-vous cochés seront remplacés (y compris leurs personnalisations). Les rappels déjà envoyés restent dans l&apos;historique ; les échéances dépassées ne sont pas créées.</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {reapply.map((b) => (
                  <li key={b.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={selected.includes(b.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, b.id] : selected.filter((x) => x !== b.id))} />
                      {formatLongDate(b.starts_at, DEFAULT_TZ)} {formatTimeShort(b.starts_at, DEFAULT_TZ)} · {b.name}
                      {b.customized && <Badge tone="warning">personnalisé</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy || selected.length === 0} onClick={async () => {
                  setBusy(true);
                  const r = await attempt(() => reapplyRulesManyAction(selected));
                  setBusy(false);
                  if (!r.ok) return toast.error(r.error);
                  toast.success(`${r.data} rendez-vous mis à jour`);
                  setReapply(null);
                }}>Appliquer à {selected.length} rendez-vous</Button>
                <Button variant="ghost" onClick={() => setReapply(null)}>Annuler</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
