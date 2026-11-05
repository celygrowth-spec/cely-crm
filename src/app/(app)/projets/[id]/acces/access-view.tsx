"use client";

// Accès client : un code individuel par personne, affiché une seule fois, révocable et régénérable.
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldOff, UserMinus } from "lucide-react";
import { addMemberAction, issueAccessAction, removeMemberAction, revokeAccessAction, setAccessExpiryAction } from "@/app/projets-actions";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Member, Project } from "@/lib/projects/types";

type Person = { id: string; first_name: string | null; last_name: string | null; email: string | null };
const nameOf = (p: { first_name: string | null; last_name: string | null; email: string | null }) => [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Contact";

function accessState(m: Member, now: number) {
  const a = m.access;
  if (!a) return { label: "Aucun accès", tone: "neutral" as const };
  if (a.revoked_at) return { label: "Révoqué", tone: "danger" as const };
  if (a.expires_at && Date.parse(a.expires_at) <= now) return { label: "Expiré", tone: "warning" as const };
  return { label: "Actif", tone: "success" as const };
}

export function AccessView({ project, members, candidates }: { project: Project; members: Member[]; candidates: Person[] }) {
  const sync = useSync();
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; code: string; url: string } | null>(null);
  const [issuing, setIssuing] = useState<Member | null>(null);
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
          Ce projet n&apos;est pas encore publié : un code fonctionnera, mais le client ne verra ce projet qu&apos;après publication (onglet Général).
        </p>
      )}
      <Card className="p-4">
        <h2 className="font-display text-base font-bold text-ink">Contacts du projet</h2>
        <p className="mb-3 text-xs text-muted">Un code personnel par contact : chaque modification sur le portail est attribuée à son auteur, et révoquer une personne ne bloque pas les autres. Le code ouvre tous les projets publiés dont la personne est membre.</p>
        {members.length === 0 ? <EmptyState title="Aucun contact" description="Ajoutez un contact de la fiche CRM pour lui donner accès au portail." /> : (
          <ul className="divide-y divide-line">
            {members.map((m) => {
              const st = accessState(m, now);
              const a = m.access;
              return (
                <li key={m.person_id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-48 flex-1">
                    <p className="font-semibold text-ink">{nameOf(m)}</p>
                    <p className="text-xs text-muted">{m.email ?? "Pas d'email"}</p>
                  </div>
                  <div className="min-w-56 text-xs text-muted">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {a && !a.revoked_at && <span className="ml-2 font-label">Code ····{a.code_hint}</span>}
                    {a && (
                      <span className="mt-1 block">
                        Créé le {formatDate(a.code_generated_at)}
                        {a.expires_at && <> · expire le {formatDate(a.expires_at)}</>}
                        {" · "}{a.last_used_at ? `dernière connexion ${formatDateTime(a.last_used_at)}` : "jamais utilisé"}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {!a || a.revoked_at ? (
                      <Button size="sm" variant="primary" disabled={!!busy} onClick={() => setIssuing(m)}><KeyRound size={13} /> Générer un accès</Button>
                    ) : (
                      <>
                        <Button size="sm" disabled={!!busy} onClick={() => setIssuing(m)}><RefreshCw size={13} /> Régénérer</Button>
                        <Button size="sm" variant="danger" disabled={!!busy} onClick={() => confirm(`Révoquer l'accès de ${nameOf(m)} ? Ses sessions ouvertes seront fermées, sur tous ses projets.`) && act(m.person_id, () => revokeAccessAction(m.person_id), "Accès révoqué")}><ShieldOff size={13} /> Révoquer</Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" disabled={!!busy} title="Retirer du projet" onClick={() => confirm(`Retirer ${nameOf(m)} de ce projet ? Son code reste valable pour ses autres projets.`) && act(m.person_id, () => removeMemberAction(project.id, m.person_id), "Contact retiré du projet")}><UserMinus size={13} /></Button>
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

      <IssueModal
        member={issuing}
        busy={!!busy}
        onClose={() => setIssuing(null)}
        onIssue={async (m, expires) => {
          const data = await act(m.person_id, () => issueAccessAction(m.person_id, expires));
          if (data) {
            setIssuing(null);
            setIssued({ name: nameOf(m), ...data });
          }
        }}
        onExpiry={async (m, expires) => {
          if (await act(m.person_id, () => setAccessExpiryAction(m.person_id, expires), "Expiration enregistrée") !== null) setIssuing(null);
        }}
      />
      <Modal open={!!issued} onClose={() => setIssued(null)} title="Accès créé">
        {issued && <Issued {...issued} project={project.name} />}
      </Modal>
    </div>
  );
}

function IssueModal({ member, busy, onClose, onIssue, onExpiry }: {
  member: Member | null; busy: boolean; onClose: () => void;
  onIssue: (m: Member, expires: string | null) => void; onExpiry: (m: Member, expires: string | null) => void;
}) {
  const [date, setDate] = useState("");
  const existing = member?.access && !member.access.revoked_at;
  const toIso = (d: string) => (d ? new Date(`${d}T23:59:00`).toISOString() : null);
  return (
    <Modal open={!!member} onClose={onClose} title={existing ? "Régénérer le code" : "Générer un accès"}>
      {member && (
        <div className="space-y-3 text-sm">
          <p>Pour <strong>{nameOf(member)}</strong>.</p>
          {existing && <p className="rounded-lg bg-amber-50 px-3 py-2 text-warning">L&apos;ancien code cessera de fonctionner immédiatement et ses sessions ouvertes seront fermées.</p>}
          <Field label="Expiration (facultatif)" hint="Sans date, l'accès reste valable jusqu'à révocation.">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-48" />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            {existing && <Button variant="ghost" disabled={busy} onClick={() => onExpiry(member, toIso(date))}>Changer seulement l&apos;expiration</Button>}
            <Button variant="primary" disabled={busy} onClick={() => onIssue(member, toIso(date))}>{existing ? "Régénérer le code" : "Générer le code"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Issued({ name, code, url, project }: { name: string; code: string; url: string; project: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const message = `Bonjour,\n\nVotre espace projet « ${project} » est disponible :\n${url}\n\nVotre code d'accès personnel : ${code}\n\nCe code vous est réservé : merci de ne pas le partager.`;
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Copie impossible : sélectionnez le texte manuellement.");
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p>Transmettez ces informations à <strong>{name}</strong>. <strong>Le code ne sera plus affiché</strong> : en cas de perte, régénérez-le.</p>
      {([["Lien", url], ["Code", code]] as const).map(([k, val]) => (
        <div key={k}>
          <p className="mb-1 font-label text-xs font-semibold text-muted">{k}</p>
          <div className="flex gap-2">
            <code className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 font-label text-sm break-all select-all">{val}</code>
            <Button onClick={() => copy(k, val)} aria-label={`Copier ${k.toLowerCase()}`}>{copied === k ? <Check size={14} /> : <Copy size={14} />}</Button>
          </div>
        </div>
      ))}
      <Button variant="primary" onClick={() => copy("msg", message)}>{copied === "msg" ? <Check size={14} /> : <Copy size={14} />} Copier un message prêt à envoyer</Button>
      <p className="text-xs text-muted">Conseil : envoyez le lien et le code par deux canaux différents (email et SMS, par exemple). Aucun email n&apos;est envoyé automatiquement.</p>
    </div>
  );
}
