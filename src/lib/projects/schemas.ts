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
