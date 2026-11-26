import "server-only";
// Invitation au portail client (et lien de réinitialisation) : contenu du mail, aperçu exact, envoi.
// L'envoi passe par le service Mail partagé (sendMail, session du propriétaire). Le vrai lien n'est créé
// qu'au moment de l'envoi ; l'aperçu montre le même rendu avec un lien factice.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/service";
import { escapeHtml, renderEmailHtml } from "@/lib/mail/render";
import { listAccounts, mailConfig, safeHtml, sendMail } from "@/lib/mail/service";
import { isEmail, withSignature, type MailAccount } from "@/lib/mail/types";
import { MAIL_UTM, tagHtmlLinks, tagTextLinks } from "@/lib/tracking/mail-utm";
import { newInviteToken, normalizeEmail } from "./portal-auth";
import { idv, rpc } from "./service";

export type InvitationKind = "invitation" | "reset";

export type InvitationPreview = {
  to: string | null;
  from: string | null;
  subject: string;
  html: string;
  text: string;
  /** Raison pour laquelle l'envoi est impossible (rien n'est envoyé tant qu'elle existe). */
  problem: string | null;
};

const SAMPLE_TOKEN = "exemple-de-lien-le-vrai-lien-est-cree-a-l-envoi";

export const activationLink = (origin: string, token: string) => `${origin}/portail/activer#${token}`;

/** Corps du mail (avant signature), identique pour l'aperçu et l'envoi. */
export function invitationContent(kind: InvitationKind, d: { firstName: string | null; project: string; link: string }) {
  const hello = d.firstName ? `Bonjour ${d.firstName},` : "Bonjour,";
  const lines =
    kind === "reset"
      ? {
          subject: "Votre nouveau mot de passe pour votre espace projet",
          intro: "Vous avez demandé à changer le mot de passe de votre espace projet Cely Growth.",
          action: "Choisir mon nouveau mot de passe",
          validity: "Ce lien est personnel, valable 24 heures et utilisable une seule fois.",
        }
      : {
          subject: `Votre espace projet « ${d.project} »`,
          intro: `Votre espace projet « ${d.project} » est disponible sur le portail client de Cely Growth.`,
          action: "Créer mon accès",
          validity: "Ce lien est personnel, valable 7 jours et utilisable une seule fois. Votre identifiant sera votre adresse email.",
        };
  const text = [hello, "", lines.intro, "", `${lines.action} : ${d.link}`, "", lines.validity, "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."].join("\n");
  const html = [
    `<p>${escapeHtml(hello)}</p>`,
    `<p>${escapeHtml(lines.intro)}</p>`,
    `<p><strong><a href="${escapeHtml(d.link)}">${escapeHtml(lines.action)}</a></strong></p>`,
    `<p>${escapeHtml(lines.validity)}<br>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`,
  ].join("");
  return { subject: lines.subject, text, html };
}

/** Rendu final, comme le service Mail l'envoie (nettoyage, signature, liens du site). */
function rendered(content: { subject: string; text: string; html: string }, account: MailAccount | null) {
  const signature = account?.signature ?? "";
  return {
    subject: content.subject,
    html: tagHtmlLinks(renderEmailHtml(safeHtml(content.html), signature), MAIL_UTM),
    text: tagTextLinks(withSignature(content.text, signature), MAIL_UTM),
  };
}

const fromLabel = (a: MailAccount) => (a.display_name ? `${a.display_name} <${a.email}>` : a.email);

async function context(sb: SupabaseClient, personId: string, projectId: string) {
  const [person, project, accounts] = await Promise.all([
    sb.from("people").select("id, first_name, email").eq("id", idv(personId)).maybeSingle(),
    sb.from("projects").select("id, name").eq("id", idv(projectId)).maybeSingle(),
    mailConfig() ? listAccounts(sb) : Promise.resolve([] as MailAccount[]),
  ]);
  if (person.error || !person.data) throw new CrmError("Contact introuvable.");
  if (project.error || !project.data) throw new CrmError("Projet introuvable.");
  const account = accounts.find((a) => a.status === "connected") ?? null;
  const email = person.data.email ? normalizeEmail(person.data.email) : null;
  const problem = !email
    ? "Ce contact n'a pas d'email : ajoutez-le sur sa fiche."
    : !isEmail(email)
      ? "L'email de ce contact n'est pas valide : corrigez-le sur sa fiche."
      : !mailConfig()
        ? "Le système mail n'est pas encore configuré."
        : !account
          ? "Aucune boîte mail connectée : connectez Gmail dans Mail › Réglages."
          : null;
  return { person: person.data as { first_name: string | null }, project: project.data as { name: string }, account, email, problem };
}

export async function previewInvitation(sb: SupabaseClient, kind: InvitationKind, personId: string, projectId: string, origin: string): Promise<InvitationPreview> {
  const c = await context(sb, personId, projectId);
  const content = invitationContent(kind, { firstName: c.person.first_name, project: c.project.name, link: activationLink(origin, SAMPLE_TOKEN) });
  return { to: c.email, from: c.account ? fromLabel(c.account) : null, ...rendered(content, c.account), problem: c.problem };
}

export const sendInvitationSchema = z.object({
  kind: z.enum(["invitation", "reset"]),
  personId: z.uuid(),
  projectId: z.uuid(),
  /** Une clé par ouverture de l'aperçu : un double clic ne crée qu'une invitation et n'envoie qu'un mail. */
  requestId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type SendInvitationInput = z.input<typeof sendInvitationSchema>;

export type SendInvitationResult = { status: "sent" | "uncertain" | "already_sent" | "in_progress"; email: string };

type Created = { id: string; email: string; duplicate: boolean; sent: boolean; invalidated: boolean; company_id?: string };

export async function sendInvitation(sb: SupabaseClient, input: SendInvitationInput, origin: string): Promise<SendInvitationResult> {
  const r = sendInvitationSchema.parse(input);
  const c = await context(sb, r.personId, r.projectId);
  if (c.problem) throw new CrmError(c.problem);
  const token = newInviteToken();
  const created = await rpc<Created>(sb, "portal_invite_create", {
    p_person: r.personId, p_project: r.projectId, p_kind: r.kind, p_token_hash: token.hash, p_request_id: r.requestId, p_expires_at: r.expiresAt ?? null,
  });
  if (created.duplicate) {
    if (created.invalidated) throw new CrmError("Cet envoi a échoué. Ouvrez à nouveau l'aperçu pour réessayer.");
    return { status: created.sent ? "already_sent" : "in_progress", email: created.email };
  }
  // destinataire : l'email enregistré avec l'invitation, jamais une valeur venue de l'écran
  const content = invitationContent(r.kind, { firstName: c.person.first_name, project: c.project.name, link: activationLink(origin, token.token) });
  const failed = async (message: string): Promise<never> => {
    await rpc(sb, "portal_invite_mark", { p_id: created.id, p_sent: false, p_mail_id: null }).catch(() => undefined);
    throw new CrmError(`L'invitation n'a pas pu être envoyée : ${message} Rien n'a été envoyé au contact ; vous pouvez réessayer.`);
  };
  let mail;
  try {
    mail = await sendMail(sb, {
      accountId: c.account?.id,
      to: [created.email],
      subject: content.subject,
      text: content.text,
      html: content.html,
      origin: "system",
      companyId: created.company_id,
      personId: r.personId,
      business: { type: r.kind === "reset" ? "portal_reset" : "portal_invitation", id: created.id },
      dedupeKey: `portal-invitation:${created.id}`,
    });
  } catch (e) {
    return failed(e instanceof CrmError ? e.message : "erreur du service mail.");
  }
  if (mail.status === "failed") return failed(mail.last_error ?? "Gmail a refusé le message.");
  // « incertain » : le message est peut-être parti ; il ne faut jamais le renvoyer automatiquement
  await rpc(sb, "portal_invite_mark", { p_id: created.id, p_sent: true, p_mail_id: mail.id });
  return { status: mail.status === "accepted" ? "sent" : mail.status === "uncertain" ? "uncertain" : "in_progress", email: created.email };
}
