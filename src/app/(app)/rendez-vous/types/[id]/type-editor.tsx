"use client";

// Éditeur d'un type de rendez-vous. Les rendez-vous déjà confirmés gardent une copie figée du type :
// une modification ne les change pas (l'écran le rappelle).
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Info, Plus, Trash2 } from "lucide-react";
import { saveEventTypeAction } from "@/app/rendez-vous-actions";
import { Button, Card, Field, Input, Select, Textarea, cn } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { slugify } from "@/lib/appointments/schemas";
import type { EventType, Question, QuestionKind } from "@/lib/appointments/types";

type Draft = Omit<EventType, "id" | "position" | "created_at" | "updated_at">;

function initial(t: EventType | null, scheduleId: string): Draft {
  if (t) {
    const { id: _id, position: _p, created_at: _c, updated_at: _u, ...rest } = t;
    void _id; void _p; void _c; void _u;
    return rest;
  }
  return {
    name: "", slug: "", description: null, duration_min: 30, location_kind: "video", location_detail: null, meeting_url: null, google_meet: false,
    schedule_id: scheduleId, buffer_before_min: 0, buffer_after_min: 10, min_notice_min: 240, horizon_days: 60, daily_limit: null,
    slot_interval_min: null, phone_required: false, questions: [], active: true,
  };
}

const NOTICE_OPTIONS = [
  [0, "Aucun"], [60, "1 heure"], [120, "2 heures"], [240, "4 heures"], [720, "12 heures"], [1440, "24 heures"], [2880, "2 jours"], [4320, "3 jours"], [10080, "7 jours"],
] as const;

export function TypeEditor({ type, schedules, upcoming }: {
  type: EventType | null; schedules: { id: string; name: string; timezone: string; is_default: boolean }[]; upcoming: number;
}) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(() => initial(type, schedules.find((s) => s.is_default)?.id ?? schedules[0]?.id ?? ""));
  const [slugTouched, setSlugTouched] = useState(!!type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await attempt(() => saveEventTypeAction(type?.id ?? null, { ...d, description: d.description ?? "" }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success(type ? "Type enregistré" : "Type créé");
    router.push("/rendez-vous/types");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="max-w-3xl space-y-5">
      {type && upcoming > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-violet-line bg-violet-soft/60 px-3 py-2 text-sm text-ink">
          <Info size={16} className="mt-0.5 shrink-0 text-violet-strong" />
          {upcoming} rendez-vous à venir gardent leurs conditions actuelles (durée, lieu, lien, questions). Les modifications s&apos;appliquent aux nouvelles réservations.
        </p>
      )}

      <Section title="Général">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Nom">
            <Input required maxLength={120} value={d.name} onChange={(e) => { set("name", e.target.value); if (!slugTouched) set("slug", slugify(e.target.value)); }} placeholder="Appel découverte" />
          </Field>
          <Field label="Lien public" hint={`/rdv/${d.slug || "…"}`}>
            <Input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={d.slug} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value.toLowerCase()); }} />
          </Field>
        </div>
        <Field label="Description (facultatif)">
          <Textarea maxLength={2000} value={d.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="Ce que la personne doit savoir avant de réserver" />
        </Field>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Durée (minutes)"><Input type="number" min={5} max={480} step={5} required value={d.duration_min} onChange={(e) => set("duration_min", Number(e.target.value))} /></Field>
          <Field label="Planning">
            <Select value={d.schedule_id} onChange={(e) => set("schedule_id", e.target.value)}>
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.timezone})</option>)}
            </Select>
          </Field>
          <Field label="Statut">
            <Select value={d.active ? "1" : "0"} onChange={(e) => set("active", e.target.value === "1")}>
              <option value="1">Actif (réservable)</option>
              <option value="0">Désactivé</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Lieu">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Type de lieu">
            <Select value={d.location_kind} onChange={(e) => set("location_kind", e.target.value as Draft["location_kind"])}>
              <option value="video">Visioconférence</option>
              <option value="phone">Téléphone (je rappelle)</option>
              <option value="other">Autre (adresse…)</option>
            </Select>
          </Field>
          {d.location_kind === "video" && (
            <Field label="Lien de réunion fixe (facultatif)" className="md:col-span-2" hint="Zoom, Meet, Teams… https:// obligatoire">
              <Input type="url" maxLength={500} value={d.meeting_url ?? ""} onChange={(e) => set("meeting_url", e.target.value || null)} placeholder="https://" />
            </Field>
          )}
          {d.location_kind !== "video" && (
            <Field label={d.location_kind === "phone" ? "Précision (facultatif)" : "Adresse ou consigne"} className="md:col-span-2">
              <Input maxLength={500} value={d.location_detail ?? ""} onChange={(e) => set("location_detail", e.target.value || null)} />
            </Field>
          )}
        </div>
        {d.location_kind === "video" && !d.meeting_url && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.google_meet} onChange={(e) => set("google_meet", e.target.checked)} />
            Générer un lien Google Meet pour chaque rendez-vous (nécessite l&apos;agenda Google connecté)
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.phone_required || d.location_kind === "phone"} disabled={d.location_kind === "phone"} onChange={(e) => set("phone_required", e.target.checked)} />
          Téléphone obligatoire dans le formulaire {d.location_kind === "phone" && <span className="text-xs text-muted">(toujours pour un rendez-vous téléphonique)</span>}
        </label>
      </Section>

      <Section title="Règles de réservation">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Battement avant (min)"><Input type="number" min={0} max={240} value={d.buffer_before_min} onChange={(e) => set("buffer_before_min", Number(e.target.value))} /></Field>
          <Field label="Battement après (min)"><Input type="number" min={0} max={240} value={d.buffer_after_min} onChange={(e) => set("buffer_after_min", Number(e.target.value))} /></Field>
          <Field label="Intervalle des créneaux" hint="Par défaut : la durée">
            <Select value={d.slot_interval_min ?? ""} onChange={(e) => set("slot_interval_min", e.target.value ? Number(e.target.value) : null)}>
              <option value="">Durée du rendez-vous</option>
              {[10, 15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>Toutes les {m} min</option>)}
            </Select>
          </Field>
          <Field label="Délai minimum avant réservation">
            <Select value={d.min_notice_min} onChange={(e) => set("min_notice_min", Number(e.target.value))}>
              {NOTICE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {!NOTICE_OPTIONS.some(([v]) => v === d.min_notice_min) && <option value={d.min_notice_min}>{d.min_notice_min} min</option>}
            </Select>
          </Field>
          <Field label="Horizon maximal (jours)"><Input type="number" min={1} max={365} value={d.horizon_days} onChange={(e) => set("horizon_days", Number(e.target.value))} /></Field>
          <Field label="Limite par jour (facultatif)"><Input type="number" min={1} max={50} value={d.daily_limit ?? ""} onChange={(e) => set("daily_limit", e.target.value ? Number(e.target.value) : null)} placeholder="Illimité" /></Field>
        </div>
        <p className="text-xs text-muted">Les battements s&apos;ajoutent autour du rendez-vous et s&apos;appliquent face aux autres rendez-vous (tous types) et aux occupations de Google Agenda.</p>
      </Section>

      <Section title="Questions du formulaire">
        <p className="text-xs text-muted">Prénom, nom, email, entreprise, site et téléphone sont toujours demandés. Ajoutez vos questions :</p>
        <QuestionsEditor value={d.questions} onChange={(q) => set("questions", q)} />
      </Section>

      {error && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="sticky bottom-16 flex gap-2 rounded-xl border border-line bg-white/95 p-3 backdrop-blur md:bottom-4">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
        <Button variant="ghost" onClick={() => router.push("/rendez-vous/types")}>Annuler</Button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-display text-base font-bold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

const KIND_LABELS: Record<QuestionKind, string> = { short: "Texte court", long: "Texte long", choice: "Choix" };

function QuestionsEditor({ value, onChange }: { value: Question[]; onChange: (q: Question[]) => void }) {
  const update = (i: number, patch: Partial<Question>) => onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {value.map((q, i) => (
        <div key={q.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={`Question ${i + 1}`} className="min-w-56 flex-1">
              <Input required maxLength={200} value={q.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Quel est votre besoin ?" />
            </Field>
            <Field label="Type" className="w-36">
              <Select value={q.kind} onChange={(e) => update(i, { kind: e.target.value as QuestionKind, options: e.target.value === "choice" ? (q.options?.length ? q.options : ["", ""]) : undefined })}>
                {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <label className="flex h-9 items-center gap-1.5 text-sm"><input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} /> Obligatoire</label>
            <div className="flex">
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter"><ArrowUp size={13} /></Button>
              <Button size="sm" variant="ghost" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label="Descendre"><ArrowDown size={13} /></Button>
              <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Supprimer la question"><Trash2 size={13} /></Button>
            </div>
          </div>
          {q.kind === "choice" && (
            <div className="mt-2 space-y-1.5 pl-1">
              {(q.options ?? []).map((o, k) => (
                <div key={k} className="flex gap-2">
                  <Input value={o} required maxLength={120} onChange={(e) => update(i, { options: q.options!.map((x, m) => (m === k ? e.target.value : x)) })} placeholder={`Option ${k + 1}`} className="max-w-sm" />
                  <Button size="sm" variant="ghost" disabled={(q.options?.length ?? 0) <= 2} onClick={() => update(i, { options: q.options!.filter((_, m) => m !== k) })} aria-label="Retirer l'option"><Trash2 size={13} /></Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => update(i, { options: [...(q.options ?? []), ""] })}><Plus size={13} /> Option</Button>
            </div>
          )}
        </div>
      ))}
      <Button size="sm" disabled={value.length >= 20} onClick={() => onChange([...value, { id: `q${Date.now().toString(36)}`, label: "", kind: "short", required: false }])} className={cn(value.length >= 20 && "opacity-50")}>
        <Plus size={13} /> Ajouter une question
      </Button>
    </div>
  );
}
