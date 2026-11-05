// Validation serveur des saisies du module Rendez-vous (la base revérifie les règles essentielles).
import { z } from "zod";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `${max} caractères maximum`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Heure invalide (HH:MM)");

export const questionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    label: z.string().trim().min(1, "Intitulé de question obligatoire").max(200),
    kind: z.enum(["short", "long", "choice"]),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .refine((q) => q.kind !== "choice" || (q.options?.length ?? 0) >= 2, { message: "Une question à choix demande au moins deux options" })
  .transform((q) => (q.kind === "choice" ? q : { ...q, options: undefined }));

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export const eventTypeSchema = z
  .object({
    name: z.string().trim().min(1, "Le nom est obligatoire").max(120),
    slug: z.string().trim().toLowerCase().max(80).regex(SLUG_RE, "Lien : lettres minuscules, chiffres et tirets uniquement"),
    description: optText(2000),
    duration_min: z.coerce.number().int().min(5, "5 minutes minimum").max(480, "8 heures maximum"),
    location_kind: z.enum(["video", "phone", "other"]),
    location_detail: optText(500),
    meeting_url: optText(500).refine((v) => !v || /^https:\/\/\S+$/.test(v), "Le lien de réunion doit commencer par https://"),
    google_meet: z.boolean(),
    schedule_id: z.uuid("Choisissez un planning"),
    buffer_before_min: z.coerce.number().int().min(0).max(240),
    buffer_after_min: z.coerce.number().int().min(0).max(240),
    min_notice_min: z.coerce.number().int().min(0).max(43200),
    horizon_days: z.coerce.number().int().min(1).max(365),
    daily_limit: z.coerce.number().int().min(1).max(50).nullable(),
    slot_interval_min: z.coerce.number().int().min(5).max(240).nullable(),
    phone_required: z.boolean(),
    questions: z.array(questionSchema).max(20),
    active: z.boolean(),
  })
  .refine((e) => new Set(e.questions.map((q) => q.id)).size === e.questions.length, { message: "Questions en double" });
export type EventTypeInput = z.input<typeof eventTypeSchema>;

export const scheduleSchema = z.object({
  name: z.string().trim().min(1, "Nom obligatoire").max(80),
  timezone: z.string().min(1).max(64),
  is_default: z.boolean(),
  rules: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(70),
  overrides: z
    .array(z.object({ date: z.iso.date(), start: time.nullable().optional(), end: time.nullable().optional() }))
    .max(500),
});
export type ScheduleInput = z.input<typeof scheduleSchema>;

export const blockSchema = z
  .object({
    label: optText(120),
    start_date: z.iso.date(),
    end_date: z.iso.date(),
    start_time: time.nullable(),
    end_time: time.nullable(),
    timezone: z.string().min(1).max(64),
  })
  .refine((b) => b.end_date >= b.start_date, { message: "La date de fin précède la date de début" })
  .refine((b) => (b.start_time === null) === (b.end_time === null), { message: "Indiquez les deux heures, ou aucune (journée entière)" });
export type BlockInput = z.input<typeof blockSchema>;

export const inviteeSchema = z.object({
  first_name: z.string().trim().min(1, "Prénom obligatoire").max(100),
  last_name: z.string().trim().min(1, "Nom obligatoire").max(100),
  email: z.string().trim().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Email invalide"),
  company_name: optText(200),
  website: optText(300),
  phone: optText(50),
  timezone: z.string().min(1).max(64),
});
export type InviteeInput = z.input<typeof inviteeSchema>;

export const bookingRequestSchema = z.object({
  slug: z.string().trim().toLowerCase().max(80).regex(SLUG_RE),
  starts_at: z.iso.datetime({ offset: true }),
  invitee: inviteeSchema,
  answers: z.record(z.string().max(40), z.string().max(5000)),
  idempotency_key: z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/),
});
export type BookingRequest = z.input<typeof bookingRequestSchema>;

export const settingsSchema = z.object({
  display_name: z.string().trim().min(1, "Nom affiché obligatoire").max(120),
  intro: optText(1000),
});
