import { z } from "zod";

const optText = (max: number) => z.string().trim().max(max, `${max} caractères maximum`).optional().nullable().transform((v) => (v ? v : null));
const optDate = z.iso.date("Date invalide").optional().nullable().or(z.literal("").transform(() => null));

export const projectCreateSchema = z
  .object({
    company_id: z.uuid("Choisissez une entreprise"),
    name: z.string().trim().min(1, "Nom du projet obligatoire").max(160),
    description: optText(2000),
    start_date: optDate,
    end_date: optDate,
    person_ids: z.array(z.uuid()).max(30),
  })
  .refine((p) => !p.start_date || !p.end_date || p.end_date >= p.start_date, { message: "La fin prévue précède le début" });
export type ProjectCreateInput = z.input<typeof projectCreateSchema>;

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1, "Nom obligatoire").max(160),
    description: optText(2000),
    status: z.enum(["a_preparer", "en_cours", "en_attente", "termine", "archive"]),
    start_date: optDate,
    end_date: optDate,
    client_update: optText(2000),
    internal_note: optText(10000),
    blocked_reason: optText(500),
    portal_published: z.boolean(),
    archived_portal: z.enum(["read_only", "closed"]),
  })
  .partial()
  .refine((p) => !p.start_date || !p.end_date || p.end_date >= p.start_date, { message: "La fin prévue précède le début" });
export type ProjectPatch = z.input<typeof projectPatchSchema>;

const date = z.iso.date("Date invalide");
export const phaseSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "Nom de phase obligatoire").max(80),
    description: optText(1000),
    deliverables: optText(1000),
    start_date: optDate,
    end_date: optDate,
    color: z.enum(["violet", "blue", "teal", "green", "amber", "pink", "slate"]),
    status: z.enum(["a_venir", "en_cours", "termine", "en_pause"]),
  })
  .refine((p) => !p.start_date || !p.end_date || p.end_date >= p.start_date, { message: "Une phase se termine avant de commencer" });
export const milestoneSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1, "Titre de jalon obligatoire").max(160),
  due_date: date,
  done: z.boolean(),
  phase_id: z.uuid().nullable().optional(),
  visible_to_client: z.boolean(),
});
export type PhaseInput = z.input<typeof phaseSchema>;
export type MilestoneInput = z.input<typeof milestoneSchema>;

export const meetingCreateSchema = z.object({
  type_id: z.uuid("Choisissez un type de rendez-vous"),
  person_id: z.uuid("Choisissez un contact"),
  starts_at: z.iso.datetime({ offset: true }),
  duration_min: z.coerce.number().int().min(5).max(480).nullable(),
  title: optText(160),
  agenda: optText(4000),
  participants: optText(500),
  visible: z.boolean(),
  idempotency_key: z.string().min(8).max(100),
});
export type MeetingCreateInput = z.input<typeof meetingCreateSchema>;

export const meetingPatchSchema = z.object({ title: optText(160), agenda: optText(4000), participants: optText(500), visible_to_client: z.boolean() });

const url = z.string().trim().max(500).regex(/^https?:\/\/\S+$/, "Lien invalide (http:// ou https://)");
export const recapSchema = z.object({
  summary: optText(8000),
  decisions: optText(4000),
  actions: z.array(z.object({ text: z.string().trim().min(1).max(300), task_id: z.uuid().nullable().optional() })).max(30),
  next_step: optText(2000),
  links: z.array(z.object({ label: z.string().trim().min(1, "Libellé du lien obligatoire").max(120), url })).max(20),
  internal_note: optText(8000),
});
export type RecapInput = z.input<typeof recapSchema>;
