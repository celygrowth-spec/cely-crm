"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
import { deleteBlockAction, deleteScheduleAction, saveBlockAction, saveScheduleAction } from "@/app/rendez-vous-actions";
import { Badge, Button, Card, Field, Input, Select, cn } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { COMMON_TIME_ZONES, DEFAULT_TZ, formatLongDate, formatTimeShort, timeZoneLabel } from "@/lib/appointments/time";
import type { Block, Override, Rule, Schedule } from "@/lib/appointments/types";

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export function AvailabilityView({ schedules, blocks, usage, selectedId }: {
  schedules: Schedule[]; blocks: Block[]; usage: Record<string, string[]>; selectedId: string | null;
}) {
  const router = useRouter();
  const current = schedules.find((s) => s.id === selectedId) ?? schedules.find((s) => s.is_default) ?? schedules[0];
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {schedules.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setCreating(false); router.replace(`/rendez-vous/disponibilites?planning=${s.id}`, { scroll: false }); }}
            className={cn("rounded-full border px-3 py-1.5 text-sm font-semibold", !creating && current?.id === s.id ? "border-ink bg-ink text-white" : "border-line text-ink hover:border-violet")}
          >
            {s.name}{s.is_default && <span className="ml-1 font-normal opacity-70">· par défaut</span>}
          </button>
        ))}
        <Button size="sm" onClick={() => setCreating(true)}><Plus size={13} /> Nouveau planning</Button>
      </div>
      {creating ? (
        <ScheduleEditor key="new" schedule={null} usedBy={[]} onSaved={(id) => { setCreating(false); router.replace(`/rendez-vous/disponibilites?planning=${id}`); }} />
      ) : current ? (
        <ScheduleEditor key={current.id} schedule={current} usedBy={usage[current.id] ?? []} onSaved={() => undefined} />
      ) : null}
      <Blocks blocks={blocks} />
    </div>
  );
}

function ScheduleEditor({ schedule, usedBy, onSaved }: { schedule: Schedule | null; usedBy: string[]; onSaved: (id: string) => void }) {
  const sync = useSync();
  const router = useRouter();
  const [name, setName] = useState(schedule?.name ?? "Nouveau planning");
  const [tz, setTz] = useState(schedule?.timezone ?? DEFAULT_TZ);
  const [isDefault, setIsDefault] = useState(schedule?.is_default ?? false);
  const [rules, setRules] = useState<Rule[]>(schedule?.rules ?? [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start: "09:00", end: "17:00" })));
  const [overrides, setOverrides] = useState<Override[]>(schedule?.overrides ?? []);
  const [busy, setBusy] = useState(false);
  const [newDate, setNewDate] = useState("");

  async function save() {
    setBusy(true);
    const r = await attempt(() => saveScheduleAction(schedule?.id ?? null, { name, timezone: tz, is_default: isDefault, rules, overrides }));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Disponibilités enregistrées");
    sync();
    onSaved(r.data.id);
  }

  const dayRules = (d: number) => rules.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === d);
  const zones = COMMON_TIME_ZONES.includes(tz) ? COMMON_TIME_ZONES : [tz, ...COMMON_TIME_ZONES];

  return (
    <Card className="space-y-5 p-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Nom du planning"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="Fuseau horaire">
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{timeZoneLabel(z)}</option>)}</Select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={isDefault} disabled={schedule?.is_default} onChange={(e) => setIsDefault(e.target.checked)} /> Planning par défaut</label>
      </div>
      {usedBy.length > 0 && <p className="text-xs text-muted">Utilisé par : {usedBy.join(", ")}</p>}

      <div>
        <h3 className="mb-2 font-display text-base font-bold text-ink">Horaires hebdomadaires</h3>
        <div className="divide-y divide-line rounded-lg border border-line">
          {DAYS.map((label, idx) => {
            const d = idx + 1;
            const list = dayRules(d);
            return (
              <div key={d} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <label className="flex w-28 items-center gap-2 pt-1.5 text-sm font-semibold">
                  <input type="checkbox" checked={list.length > 0} onChange={(e) => setRules(e.target.checked ? [...rules, { weekday: d, start: "09:00", end: "17:00" }] : rules.filter((r) => r.weekday !== d))} />
                  {label}
                </label>
                <div className="flex flex-1 flex-col gap-1.5">
                  {list.length === 0 && <span className="pt-1.5 text-sm text-muted">Indisponible</span>}
                  {list.map(({ r, i }) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input type="time" value={r.start} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className="w-28" aria-label={`${label} début`} />
                      <span className="text-muted">–</span>
                      <Input type="time" value={r.end === "24:00" ? "23:59" : r.end} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, end: e.target.value === "23:59" ? "24:00" : e.target.value } : x)))} className="w-28" aria-label={`${label} fin`} />
                      <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Retirer la plage"><Trash2 size={13} /></Button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1">
                  {list.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setRules([...rules, { weekday: d, start: list.at(-1)!.r.end < "23:00" ? list.at(-1)!.r.end : "18:00", end: "19:00" }])} aria-label={`Ajouter une plage le ${label}`}>
                      <Plus size={13} />
                    </Button>
                  )}
                  {list.length > 0 && (
                    <Button size="sm" variant="ghost" title="Copier sur les autres jours ouvrés" onClick={() => {
                      // remplace les horaires des autres jours ouvrés par ceux de ce jour
                      const src = list.map((x) => x.r);
                      setRules([...rules.filter((r) => r.weekday === d || r.weekday > 5), ...[1, 2, 3, 4, 5].filter((w) => w !== d).flatMap((w) => src.map((x) => ({ ...x, weekday: w })))]);
                    }} aria-label="Copier sur lundi–vendredi">
                      <Copy size={13} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="mb-1 font-display text-base font-bold text-ink">Exceptions par date</h3>
        <p className="mb-2 text-xs text-muted">Une date indisponible, ou des horaires différents ce jour-là (remplacent les horaires hebdomadaires).</p>
        <div className="mb-2 flex flex-wrap gap-2">
          <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-44" aria-label="Date de l'exception" />
          <Button size="sm" disabled={!newDate || overrides.some((o) => o.date === newDate)} onClick={() => { setOverrides([...overrides, { date: newDate }].sort((a, b) => a.date.localeCompare(b.date))); setNewDate(""); }}>Indisponible ce jour</Button>
          <Button size="sm" disabled={!newDate || overrides.some((o) => o.date === newDate)} onClick={() => { setOverrides([...overrides, { date: newDate, start: "09:00", end: "12:00" }].sort((a, b) => a.date.localeCompare(b.date))); setNewDate(""); }}>Horaires spécifiques</Button>
        </div>
        {overrides.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {overrides.map((o, i) => (
              <li key={`${o.date}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="w-56 font-semibold">{formatLongDate(`${o.date}T12:00:00Z`, "UTC")}</span>
                {o.start ? (
                  <>
                    <Input type="time" value={o.start} onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className="w-28" aria-label="Début" />
                    <span>–</span>
                    <Input type="time" value={o.end ?? ""} onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} className="w-28" aria-label="Fin" />
                    <Button size="sm" variant="ghost" onClick={() => setOverrides([...overrides.slice(0, i + 1), { date: o.date, start: "14:00", end: "17:00" }, ...overrides.slice(i + 1)])}><Plus size={13} /> Plage</Button>
                  </>
                ) : <Badge tone="danger">Indisponible</Badge>}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))} aria-label="Retirer"><Trash2 size={13} /></Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
        {schedule && !schedule.is_default && (
          <Button variant="danger" disabled={busy || usedBy.length > 0} title={usedBy.length ? "Utilisé par un type" : undefined} onClick={async () => {
            if (!confirm(`Supprimer le planning « ${schedule.name} » ?`)) return;
            const r = await attempt(() => deleteScheduleAction(schedule.id));
            if (!r.ok) return toast.error(r.error);
            toast.success("Planning supprimé");
            router.replace("/rendez-vous/disponibilites");
            router.refresh();
          }}>Supprimer</Button>
        )}
      </div>
    </Card>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  const sync = useSync();
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("12:00");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const r = await attempt(() => saveBlockAction(null, {
      label, start_date: from, end_date: to || from, start_time: allDay ? null : startTime, end_time: allDay ? null : endTime, timezone: DEFAULT_TZ,
    }));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setLabel(""); setFrom(""); setTo("");
    toast.success("Blocage ajouté");
    sync();
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="font-display text-base font-bold text-ink">Congés et blocages</h3>
        <p className="text-xs text-muted">Communs à tous les plannings. Heures en Europe/Paris.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Libellé" className="min-w-40 flex-1"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Congés d'été" maxLength={120} /></Field>
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></Field>
        <Field label="Au"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" /></Field>
        <label className="flex h-9 items-center gap-1.5 text-sm"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Journées entières</label>
        {!allDay && (
          <>
            <Field label="De"><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-28" /></Field>
            <Field label="À"><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-28" /></Field>
          </>
        )}
        <Button variant="primary" disabled={busy || !from} onClick={add}><Plus size={14} /> Ajouter</Button>
      </div>
      {blocks.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {blocks.map((b) => (
            <li key={b.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1">
                <span className="font-semibold">{b.label ?? "Blocage"}</span>
                <span className="ml-2 text-muted">
                  {b.all_day
                    ? `${formatLongDate(b.starts_at, DEFAULT_TZ)} → ${formatLongDate(new Date(Date.parse(b.ends_at) - 1).toISOString(), DEFAULT_TZ)}`
                    : `${formatLongDate(b.starts_at, DEFAULT_TZ)} ${formatTimeShort(b.starts_at, DEFAULT_TZ)} → ${formatLongDate(b.ends_at, DEFAULT_TZ)} ${formatTimeShort(b.ends_at, DEFAULT_TZ)}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" aria-label="Supprimer le blocage" onClick={async () => {
                const r = await attempt(() => deleteBlockAction(b.id));
                if (!r.ok) return toast.error(r.error);
                sync();
              }}><Trash2 size={13} /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">Aucun congé ou blocage à venir.</p>}
    </Card>
  );
}
