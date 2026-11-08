import "server-only";
// Modèles d'email : lecture et écriture (propriétaire, sous RLS). Le HTML est nettoyé et sa version
// texte recalculée ici ; les jetons {{prenom}} d'un texte collé deviennent des variables.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/service";
import { htmlToText } from "./render";
import { safeHtml } from "./service";
import { tokensToSpans } from "./variables";

export type MailTemplate = { id: string; name: string; category: string | null; subject: string; body_html: string; body_text: string; archived_at: string | null; updated_at: string; created_at: string };

const COLS = "id, name, category, subject, body_html, body_text, archived_at, updated_at, created_at";

export async function listTemplates(sb: SupabaseClient, archived = false): Promise<MailTemplate[]> {
  let q = sb.from("mail_templates").select(COLS).order("updated_at", { ascending: false }).limit(500);
  q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  const { data, error } = await q;
  if (error) throw new CrmError(`Lecture des modèles impossible : ${error.message}`);
  return (data ?? []) as MailTemplate[];
}

export const templateSchema = z.object({
  name: z.string().trim().min(1, "Donnez un nom au modèle").max(120, "120 caractères maximum"),
  category: z.string().trim().max(60, "60 caractères maximum").nullish().transform((v) => (v ? v : null)),
  subject: z.string().max(500),
  html: z.string().max(200000),
});
export type TemplateInput = z.input<typeof templateSchema>;

export async function saveTemplate(sb: SupabaseClient, id: string | null, input: TemplateInput): Promise<MailTemplate> {
  const t = templateSchema.parse(input);
  const html = safeHtml(tokensToSpans(t.html));
  const row = { name: t.name, category: t.category, subject: t.subject, body_html: html, body_text: htmlToText(html) };
  const res = id
    ? await sb.from("mail_templates").update(row).eq("id", z.uuid().parse(id)).select(COLS).single()
    : await sb.from("mail_templates").insert(row).select(COLS).single();
  if (res.error) throw new CrmError(`Modèle non enregistré : ${res.error.message}`);
  return res.data as MailTemplate;
}

export async function duplicateTemplate(sb: SupabaseClient, id: string): Promise<MailTemplate> {
  const { data, error } = await sb.from("mail_templates").select(COLS).eq("id", z.uuid().parse(id)).single();
  if (error || !data) throw new CrmError("Modèle introuvable.");
  const t = data as MailTemplate;
  return saveTemplate(sb, null, { name: `${t.name} (copie)`.slice(0, 120), category: t.category, subject: t.subject, html: t.body_html });
}

/** Archiver ne touche ni les brouillons ni les emails déjà créés à partir du modèle. */
export async function setTemplateArchived(sb: SupabaseClient, id: string, archived: boolean) {
  const { error } = await sb.from("mail_templates").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", z.uuid().parse(id));
  if (error) throw new CrmError(`Modèle non modifié : ${error.message}`);
}
