// Validation des entrées, partagée par l'interface et le connecteur Claude.
import { z } from "zod";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `${max} caractères maximum`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const CHANNELS = ["linkedin", "email", "phone", "other"] as const;
export const channelSchema = z.enum(CHANNELS);

export const PROSPECT_STATUSES = ["nouveau", "contacte", "en_discussion", "qualifie", "pas_interesse"] as const;

export const personSchema = z
  .object({
    first_name: optText(100),
    last_name: optText(100),
    title: optText(150),
    email: z
      .string()
      .trim()
      .max(254)
      .optional()
      .nullable()
      .transform((v) => (v ? v : null))
      .refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Email invalide"),
    phone: optText(50),
    linkedin_url: optText(300),
    is_primary: z.boolean().optional(),
  })
  .refine((p) => p.first_name || p.last_name || p.email || p.linkedin_url, {
    message: "Indiquez au moins un nom, un email ou un profil LinkedIn",
  });
export type PersonInput = z.input<typeof personSchema>;

export const companySchema = z.object({
  name: z.string().trim().min(1, "Le nom de l'entreprise est obligatoire").max(200),
  website: optText(300),
  description: optText(5000),
  source_id: z.uuid().optional().nullable().or(z.literal("").transform(() => null)),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
});
export type CompanyInput = z.input<typeof companySchema>;

export const companyPatchSchema = companySchema.partial().extend({
  prospect_status: z.enum(PROSPECT_STATUSES).optional(),
  amount: z.number().nonnegative().max(1e10).nullable().optional(),
  expected_close_date: z.iso.date().nullable().optional(),
  lost_reason: optText(500),
});
export type CompanyPatch = z.input<typeof companyPatchSchema>;

export const INTERACTION_KINDS = ["note", "message_out", "message_in", "call", "meeting"] as const;

export const interactionSchema = z.object({
  company_id: z.uuid(),
  kind: z.enum(INTERACTION_KINDS),
  content: z.string().trim().max(20000).optional().nullable(),
  occurred_at: z.iso.datetime({ offset: true }).optional().nullable(),
  person_id: z.uuid().optional().nullable(),
  channel: channelSchema.optional().nullable(),
  content_origin: z.enum(["user", "claude_suggestion"]).optional(),
});
export type InteractionInput = z.input<typeof interactionSchema>;

export const taskSchema = z.object({
  company_id: z.uuid(),
  title: z.string().trim().min(1, "L'intitulé est obligatoire").max(300),
  due_date: z.iso.date("Date invalide"),
  person_id: z.uuid().optional().nullable(),
});
export type TaskInput = z.input<typeof taskSchema>;

export const idSchema = z.uuid("Identifiant invalide");
export const dateSchema = z.iso.date("Date invalide");
