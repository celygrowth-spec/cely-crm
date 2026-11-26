"use client";

// Accès client : une invitation par mail, le contact crée lui-même son mot de passe (identifiant = son email).
// Aucun code ni mot de passe n'est affiché ici. Révocation et expiration inchangées.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2, Mail, Plus, Send, ShieldOff, UserMinus } from "lucide-react";
import { addMemberAction, invitationPreviewAction, removeMemberAction, revokeAccessAction, sendInvitationAction, setAccessExpiryAction } from "@/app/projets-actions";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { formatDate, formatDateTime } from "@/lib/format";
import { isEmail } from "@/lib/mail/types";
import { accessStatus, type Member, type Project } from "@/lib/projects/types";

type Person = { id: string; first_name: string | null; last_name: string | null; email: string | null };
type Preview = { to: string | null; from: string | null; subject: string; html: string; text: string; problem: string | null };
type Kind = "invitation" | "reset";

const nameOf = (p: { first_name: string | null; last_name: string | null; email: string | null }) => [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Contact";
const toIso = (d: string) => (d ? new Date(`${d}T23:59:00`).toISOString() : null);

/** Raison pour laquelle aucun mail ne peut partir vers ce contact (bouton désactivé). */
function emailProblem(email: string | null) {
  if (!email?.trim()) return "Pas d'email sur la fiche du contact";
  if (!isEmail(email.trim().toLowerCase())) return "Email invalide sur la fiche du contact";
  return null;
}

function actionLabel(key: ReturnType<typeof accessStatus>["key"], kind: Kind | null) {
  if (kind === "reset") return "Envoyer le lien de réinitialisation";
  if (key === "legacy_code") return "Envoyer l'invitation";
  if (key === "invited" || key === "invitation_expired" || key === "invitation_cancelled") return "Renvoyer l'invitation";
  return "Prévisualisation du mail";
}

export function AccessView({ project, members, candidates }: { project: Project; members: Member[]; candidates: Person[] }) {
  const sync = useSync();
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{ member: Member; kind: Kind } | null>(null);
  const [expiring, setExpiring] = useState<Member | null>(null);
  const [addId, setAddId] = useState("");

  async function act<T>(key: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, msg?: string) {
    setBusy(key);
    const r = await attempt(fn);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    if (msg) toast.success(msg);
    sync();
    return r.data;
  }

  return (
    <div className="max-w-4xl space-y-4">
      {!project.portal_published && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning">
          Ce projet n&apos;est pas encore publié : le contact pourra créer son accès, mais il ne verra ce projet qu&apos;après publication (onglet Général).
        </p>
      )}
      <Card className="p-4">
        <h2 className="font-display text-base font-bold text-ink">Contacts du projet</h2>
        <p className="mb-3 text-xs text-muted">Chaque contact reçoit une invitation par mail et crée lui-même son mot de passe ; son identifiant est son email. Un compte ouvre tous les projets publiés dont la personne est membre : ajouter un contact déjà activé suffit, sans nouvelle invitation.</p>
        {members.length === 0 ? <EmptyState title="Aucun contact" description="Ajoutez un contact de la fiche CRM pour lui donner accès au portail." /> : (
          <ul className="divide-y divide-line">
            {members.map((m) => {
              const st = accessStatus(m, now);
              const a = m.access;
              const problem = emailProblem(m.email);
              const live = a && !a.revoked_at && (a.activated_at || a.code_hint || st.key === "invited" || st.key === "invitation_expired");
              return (
                <li key={m.person_id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-48 flex-1">
                    <p className="font-semibold text-ink">{nameOf(m)}</p>
                    <p className="text-xs text-muted">{m.email ?? "Pas d'email"}</p>
                  </div>
                  <div className="min-w-56 text-xs text-muted">
                    <Badge tone={st.tone}>{st.label}{st.date && st.key !== "legacy_code" && st.key !== "none" ? ` le ${formatDate(st.date)}` : ""}</Badge>
                    {st.key === "legacy_code" && a?.code_hint && <span className="ml-2 font-label">Code ····{a.code_hint} · valable jusqu&apos;à l&apos;activation du compte</span>}
                    {a && !a.revoked_at && (
                      <span className="mt-1 block">
                        {a.expires_at ? <>Accès jusqu&apos;au {formatDate(a.expires_at)}</> : "Sans date d'expiration"}
                        {" · "}{a.last_used_at ? `dernière connexion ${formatDateTime(a.last_used_at)}` : "jamais connecté"}
                      </span>
                    )}
                    {a?.reset_requested_at && !a.revoked_at && <span className="mt-1 block text-warning">Mot de passe oublié demandé le {formatDateTime(a.reset_requested_at)}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {st.action && (
                      <Button size="sm" variant={st.key === "invited" ? "secondary" : "primary"} disabled={!!busy || !!problem} title={problem ?? undefined}
                        onClick={() => setPreviewing({ member: m, kind: st.action! })}>
                        <Mail size={13} /> {actionLabel(st.key, st.action)}
                      </Button>
                    )}
                    {a && !a.revoked_at && (
                      <Button size="sm" variant="ghost" disabled={!!busy} title="Date d'expiration de l'accès" aria-label="Date d'expiration de l'accès" onClick={() => setExpiring(m)}><CalendarClock size={13} /></Button>
                    )}
                    {live && (
                      <Button size="sm" variant="danger" disabled={!!busy} onClick={() => confirm(`Révoquer l'accès de ${nameOf(m)} ? Ses sessions ouvertes seront fermées et son invitation en attente annulée, sur tous ses projets.`) && act(m.person_id, () => revokeAccessAction(m.person_id), "Accès révoqué")}><ShieldOff size={13} /> Révoquer</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={!!busy} title="Retirer du projet" aria-label="Retirer du projet" onClick={() => confirm(`Retirer ${nameOf(m)} de ce projet ? Son accès reste valable pour ses autres projets.`) && act(m.person_id, () => removeMemberAction(project.id, m.person_id), "Contact retiré du projet")}><UserMinus size={13} /></Button>
                    {problem && st.action && <span className="w-full text-right text-xs text-warning">{problem}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {candidates.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            <Select value={addId} onChange={(e) => setAddId(e.target.value)} className="w-72" aria-label="Contact à ajouter">
              <option value="">Ajouter un contact de {project.company_name}…</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}{c.email ? ` · ${c.email}` : ""}</option>)}
            </Select>
            <Button disabled={!addId || !!busy} onClick={async () => { if (await act("add", () => addMemberAction(project.id, addId), "Contact ajouté") !== null) setAddId(""); }}><Plus size={14} /> Ajouter</Button>
          </div>
        )}
      </Card>

      {previewing && (
        <InvitationModal
          key={`${previewing.member.person_id}:${previewing.kind}`}
          member={previewing.member}
          kind={previewing.kind}
          projectId={project.id}
          askExpiry={!previewing.member.access || !!previewing.member.access.revoked_at}
          onClose={() => setPreviewing(null)}
          onSent={() => { setPreviewing(null); sync(); }}
        />
      )}
      <ExpiryModal
        member={expiring}
        busy={!!busy}
        onClose={() => setExpiring(null)}
        onSave={async (m, expires) => {
          if (await act(m.person_id, () => setAccessExpiryAction(m.person_id, expires), "Expiration enregistrée") !== null) setExpiring(null);
        }}
      />
    </div>
  );
}

/** Aperçu exact du mail, puis envoi. Une clé de demande par ouverture : un double clic n'envoie qu'un mail. */
function InvitationModal({ member, kind, projectId, askExpiry, onClose, onSent }: {
  member: Member; kind: Kind; projectId: string; askExpiry: boolean; onClose: () => void; onSent: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [date, setDate] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let alive = true;
    attempt(() => invitationPreviewAction(kind, member.person_id, projectId)).then((r) => {
      if (!alive) return;
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [kind, member.person_id, projectId]);

  async function send() {
    if (sending) return;
    setSending(true);
    setError(null);
    const r = await attempt(() => sendInvitationAction({ kind, personId: member.person_id, projectId, requestId, expiresAt: askExpiry ? toIso(date) : null }));
    setSending(false);
    if (!r.ok) {
      // l'invitation créée a été invalidée : un nouvel essai repart d'une nouvelle demande
      setError(r.error);
      setRequestId(crypto.randomUUID());
      return;
    }
    const to = r.data.email;
    if (r.data.status === "uncertain") toast.warning(`Envoi incertain vers ${to} : vérifiez dans Mail avant de renvoyer.`);
    else if (r.data.status === "in_progress") toast.message("Cet envoi est déjà en cours.");
    else toast.success(kind === "reset" ? `Lien de réinitialisation envoyé à ${to}` : `Invitation envoyée à ${to}`);
    onSent();
  }

  const title = kind === "reset" ? "Lien de réinitialisation : aperçu du mail" : "Invitation : aperçu du mail";
  return (
    <Modal open onClose={() => !sending && onClose()} title={title} wide>
      <div className="space-y-3 text-sm">
        {!preview && !error && <p className="flex items-center gap-2 text-muted"><Loader2 size={14} className="animate-spin" /> Préparation de l&apos;aperçu…</p>}
        {preview && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">À</dt><dd className="font-semibold text-ink">{preview.to ?? "—"}</dd>
              <dt className="text-muted">De</dt><dd className="text-ink">{preview.from ?? "—"}</dd>
              <dt className="text-muted">Objet</dt><dd className="text-ink">{preview.subject}</dd>
            </dl>
            <iframe title="Aperçu du mail" sandbox="" srcDoc={preview.html} className="h-72 w-full rounded-lg border border-line bg-white" data-invitation-preview />
            <p className="text-xs text-muted">Le lien affiché est un exemple : le vrai lien, personnel et à usage unique, est créé au moment de l&apos;envoi.{kind === "invitation" ? " Il expire après 7 jours ; renvoyer une invitation annule la précédente." : " Il expire après 24 heures."}</p>
            {askExpiry && (
              <Field label="Expiration de l'accès (facultatif)" hint="Sans date, l'accès reste valable jusqu'à révocation.">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-48" disabled={sending} />
              </Field>
            )}
          </>
        )}
        {(error ?? preview?.problem) && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-danger">{error ?? preview?.problem}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={sending} onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={!preview || !!preview.problem || sending} aria-busy={sending} onClick={send}>
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {sending ? "Envoi…" : "Envoyer"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ExpiryModal({ member, busy, onClose, onSave }: { member: Member | null; busy: boolean; onClose: () => void; onSave: (m: Member, expires: string | null) => void }) {
  const [date, setDate] = useState("");
  return (
    <Modal open={!!member} onClose={onClose} title="Expiration de l'accès">
      {member && (
        <div className="space-y-3 text-sm">
          <p>Pour <strong>{nameOf(member)}</strong>, sur tous ses projets.</p>
          <Field label="Date d'expiration" hint="Laisser vide pour un accès sans date d'expiration.">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-48" />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy} onClick={() => onSave(member, toIso(date))}>Enregistrer</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
