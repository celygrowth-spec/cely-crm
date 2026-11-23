"use client";

// Panneau de suivi de l'onboarding de l'offre découverte (propriétaire) : avancement par étape, réponses, fichiers,
// cibles et commentaires, changements après envoi, lien à copier et aperçu client.
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Download, Eye, FileText, HelpCircle, Users } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Skeleton } from "@/components/ui";
import { formatBytes } from "@/lib/crm/file-rules";
import { OFFER_QUESTIONS, STEPS, UNKNOWN, type StepKey } from "@/lib/discovery/content";
import { stepProgress, unknownQuestions, type DiscoveryAdmin, type DiscoveryChange, type DiscoveryView, type StepProgress } from "@/lib/discovery/types";
import { WEBSITE_KEY } from "@/lib/discovery/website";
import { normDomain } from "@/lib/crm/normalize";
import { discoveryOp, portalOnboardingPath, useDiscoveryAdmin, useRefreshDiscovery } from "./admin-client";
import { TargetsEditor } from "./targets-editor";

const PROGRESS: Record<StepProgress, { label: string; tone: "neutral" | "warning" | "violet" | "success" }> = {
  not_started: { label: "Non commencé", tone: "neutral" },
  in_progress: { label: "En cours", tone: "warning" },
  complete: { label: "En cours · complétée", tone: "violet" },
  sent: { label: "Envoyé", tone: "success" },
};
const STATUS_TEXT: Record<string, string> = { done: "Fait", none: "Sans objet", later: "Plus tard" };
const dt = (s: string) => new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

export function DiscoveryPanel({ projectId }: { projectId: string }) {
  const q = useDiscoveryAdmin(projectId);
  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (q.error || !q.data) return <p className="text-sm text-danger">{q.error instanceof Error ? q.error.message : "Chargement impossible."}</p>;
  const a = q.data;
  if (!a.exists || !a.enabled) {
    return (
      <EmptyState
        title="Offre découverte non cochée"
        description="Cochez « Offre découverte » dans l'onglet Général (carte Portail client) pour proposer l'onboarding à ce client. Les réponses déjà saisies sont conservées."
        action={<Link href={`/projets/${projectId}`} className="text-sm font-semibold text-violet-strong hover:underline">Aller à l&apos;onglet Général</Link>}
      />
    );
  }
  return <Panel projectId={projectId} a={a} />;
}

function Panel({ projectId, a }: { projectId: string; a: Extract<DiscoveryAdmin, { exists: true }> }) {
  const refresh = useRefreshDiscovery(projectId);
  const link = typeof window === "undefined" ? portalOnboardingPath(projectId) : `${window.location.origin}${portalOnboardingPath(projectId)}`;
  const state = a.sent_at ? "Envoyé" : a.started_at ? "En cours" : "Non commencé";
  const toComplete = unknownQuestions(a);
  const site = a.answers[WEBSITE_KEY]?.value || null;
  const siteOnRecord = !!site && normDomain(site) === normDomain(a.company_website);
  return (
    <div className="grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_320px]" data-discovery-panel>
      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-bold">Onboarding offre découverte</h2>
            <Badge tone={a.sent_at ? "success" : a.started_at ? "warning" : "neutral"} data-discovery-state>{state}</Badge>
            {a.sent_at && <span className="text-xs text-muted">le {dt(a.sent_at)}{a.sent_by ? ` par ${a.sent_by}` : ""}</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Lien copié"), () => toast.error("Copie impossible : " + link))} data-discovery-copy>
                <Copy size={14} /> Copier le lien
              </Button>
              <Link href={`/projets/${projectId}/onboarding-decouverte/apercu`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-semibold hover:bg-surface" data-discovery-preview>
                <Eye size={14} /> Voir comme le client
              </Link>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">Le lien ouvre l&apos;onboarding après connexion au portail (le contact a besoin de son code d&apos;accès, onglet Accès client).</p>
          {a.changed_after_send_at && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-discovery-changed>
              <strong>Modifié après l&apos;envoi</strong> (dernière modification le {dt(a.changed_after_send_at)}) : voir « Changements depuis l&apos;envoi ».
            </p>
          )}
          {toComplete.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm" data-discovery-to-complete>
              <p className="flex items-center gap-1.5 font-semibold text-warning"><HelpCircle size={15} aria-hidden /> {UNKNOWN.crm} ({toComplete.length})</p>
              <p className="mt-0.5 text-xs text-muted">Le client a coché « {UNKNOWN.label} » : à lui demander de vive voix.</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                {toComplete.map((qq) => <li key={qq.key}>{qq.title}</li>)}
              </ul>
            </div>
          )}
          <ol className="mt-4 grid gap-2 sm:grid-cols-2" data-discovery-steps>
            {STEPS.filter((s) => s.key !== "welcome").map((s, i) => {
              const p = stepProgress(a, s.key);
              const st = a.steps[s.key as StepKey];
              return (
                <li key={s.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm" data-step={s.key} data-progress={p}>
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface text-xs font-bold">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{s.short}{s.optional ? <span className="font-normal text-muted"> · facultatif</span> : null}</span>
                  <Badge tone={PROGRESS[p].tone}>{PROGRESS[p].label}</Badge>
                  {st && st.status !== "done" && <span className="text-[11px] text-muted">{STATUS_TEXT[st.status]}</span>}
                </li>
              );
            })}
          </ol>
        </Card>

        <Card className="p-4" data-discovery-answers>
          <h3 className="mb-3 font-display text-base font-bold">Réponses sur l&apos;offre</h3>
          <dl className="space-y-3">
            {OFFER_QUESTIONS.map((qq) => {
              const ans = a.answers[qq.key];
              return (
                <div key={qq.key}>
                  <dt className="text-xs font-semibold text-muted">{qq.title}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-sm" data-answer={qq.key} data-unknown={ans?.unknown ? "" : undefined}>
                    {ans?.value ? ans.value
                      : ans?.unknown ? <Badge tone="warning"><HelpCircle size={11} aria-hidden /> {UNKNOWN.crm}</Badge>
                      : <span className="text-muted italic">Pas encore de réponse</span>}
                  </dd>
                  {ans && (ans.value || ans.unknown) && <dd className="text-[11px] text-muted">{ans.unknown && !ans.value ? `« ${UNKNOWN.label} » coché par ${ans.by ?? "le client"}` : ans.by ?? "Client"} · {dt(ans.at)}</dd>}
                </div>
              );
            })}
          </dl>
          <p className="mt-3 border-t border-line pt-3 text-sm" data-discovery-website>
            <strong>Site du client :</strong>{" "}
            {site ? (
              <>
                <a href={site} target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-strong hover:underline">{site}</a>
                <span className="block text-xs text-muted">
                  {siteOnRecord ? "Présent sur la fiche de l'entreprise." : a.company_website ? `Non recopié : la fiche indique déjà ${a.company_website}.` : "Pas encore sur la fiche."}
                  {a.company_id && <> <Link href={`/fiches/${a.company_id}`} className="font-semibold text-violet-strong hover:underline">Ouvrir la fiche</Link></>}
                </span>
              </>
            ) : <span className="text-muted">non renseigné</span>}
          </p>
          <p className="mt-2 text-sm">
            <strong>lemlist :</strong> {a.steps.lemlist?.status === "done" ? <>invitation confirmée par {a.steps.lemlist.by ?? "le client"} ({dt(a.steps.lemlist.at)})</> : <span className="text-muted">pas encore confirmée</span>}
          </p>
        </Card>

        <FilesCard projectId={projectId} a={a} />
        <TargetsEditor projectId={projectId} targets={a.targets} onSaved={refresh} />
        <ChangesCard changes={a.changes} />
      </div>

      <div className="space-y-4">
        <Card className="p-4" data-discovery-contacts>
          <h3 className="mb-2 flex items-center gap-1.5 font-display text-base font-bold"><Users size={15} aria-hidden /> Contacts du projet</h3>
          {!a.contacts.length ? <p className="text-sm text-muted">Aucun contact : ajoutez-en un dans l&apos;onglet Accès client.</p> : (
            <ul className="space-y-1.5 text-sm">
              {a.contacts.map((c) => (
                <li key={c.id}>
                  <span className="font-semibold">{c.name ?? "Contact"}</span>
                  <span className="block text-xs text-muted">{c.seen_at ? `Dernier passage ${dt(c.seen_at)} · écran « ${screenLabel(c.position)} »` : "Pas encore ouvert"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <SettingsCard projectId={projectId} value={a.settings.lemlist_invite_email} />
      </div>
    </div>
  );
}

function screenLabel(screen: string | null) {
  if (!screen) return "—";
  const [key, sub] = screen.split(":");
  const s = STEPS.find((x) => x.key === key);
  return s ? `${s.short}${sub ? ` · ${Number(sub) + 1}` : ""}` : screen;
}

function FilesCard({ projectId, a }: { projectId: string; a: DiscoveryView }) {
  const groups: { step: "blacklist" | "linkedin" | "documents"; title: string }[] = [
    { step: "blacklist", title: "Blacklist" }, { step: "linkedin", title: "Archives LinkedIn" }, { step: "documents", title: "Autres documents" },
  ];
  async function open(id: string) {
    const r = await discoveryOp<{ url: string }>(projectId, { op: "file_url", file: id });
    if (!r.ok) return toast.error(r.error);
    window.location.assign(r.data.url);
  }
  return (
    <Card className="p-4" data-discovery-files>
      <h3 className="font-display text-base font-bold">Fichiers déposés</h3>
      <p className="mb-3 text-xs text-muted">Rangés dans la fiche et dans le dossier interne « Onboarding offre découverte » du projet (onglet Fichiers). Liens de téléchargement valables 60 secondes.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {groups.map((g) => {
          const files = a.files.filter((f) => f.step === g.step);
          const st = a.steps[g.step]?.status;
          return (
            <div key={g.step} className="min-w-0">
              <h4 className="text-xs font-bold text-muted uppercase">{g.title}</h4>
              {!files.length ? (
                <p className="mt-1 text-sm text-muted">{st === "none" ? "Le client n'en a pas" : st === "later" ? "Ajout prévu plus tard" : "Rien pour l'instant"}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {files.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => open(f.id)} className="flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-sm hover:bg-surface">
                        <FileText size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{f.account ? `${f.account} · ` : ""}{f.name}</span>
                          <span className="block text-[11px] text-muted">{formatBytes(f.size)} · {f.by ?? "Client"} · {dt(f.at)}</span>
                        </span>
                        <Download size={13} className="mt-1 ml-auto shrink-0 text-muted" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const CHANGE_LABELS: Record<string, string> = Object.fromEntries([
  ...OFFER_QUESTIONS.map((q) => [q.key, q.title]),
  [WEBSITE_KEY, "Lien du site"],
  ...STEPS.map((s) => [s.key, s.title]),
]);
const VALUE_LABELS: Record<string, string> = { done: "fait", none: "sans objet", later: "plus tard" };

function ChangesCard({ changes }: { changes: DiscoveryChange[] }) {
  if (!changes.length) return null;
  return (
    <Card className="p-4" data-discovery-changes>
      <h3 className="mb-2 font-display text-base font-bold">Changements depuis l&apos;envoi</h3>
      <ul className="divide-y divide-line text-sm">
        {changes.map((c, i) => (
          <li key={i} className="py-2">
            <p><strong>{CHANGE_LABELS[c.label] ?? c.label}</strong> <span className="text-xs text-muted">· {c.by ?? "Client"} · {dt(c.at)}</span></p>
            {c.kind === "file_added" && <p className="text-xs">Fichier ajouté : {c.after}</p>}
            {c.kind === "file_removed" && <p className="text-xs">Fichier retiré de l&apos;onboarding (toujours dans la fiche) : {c.before}</p>}
            {c.kind === "target_comment" && <p className="text-xs">Nouveau commentaire : « {c.after} »</p>}
            {!["file_added", "file_removed", "target_comment"].includes(c.kind) && (
              <div className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
                <p className="rounded bg-red-50 px-2 py-1 whitespace-pre-wrap line-through decoration-red-300">{c.before ? VALUE_LABELS[c.before] ?? c.before : "(vide)"}</p>
                <p className="rounded bg-emerald-50 px-2 py-1 whitespace-pre-wrap">{c.after ? VALUE_LABELS[c.after] ?? c.after : "(vide)"}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SettingsCard({ projectId, value }: { projectId: string; value: string | null }) {
  const refresh = useRefreshDiscovery(projectId);
  const [email, setEmail] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await discoveryOp(projectId, { op: "settings", lemlist_invite_email: email.trim() });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Réglage enregistré (tous les onboardings)");
    refresh();
  }
  return (
    <Card className="space-y-2 p-4" data-discovery-settings>
      <h3 className="font-display text-base font-bold">Réglage</h3>
      <label className="block text-xs font-semibold text-muted" htmlFor="lemlist-invite">Adresse à inviter dans lemlist (tous les clients)</label>
      <Input id="lemlist-invite" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@votre-domaine.fr" />
      {!value && <p className="text-xs text-warning">Non renseignée : le client verra « Célien te communiquera l&apos;adresse ».</p>}
      <Button disabled={busy || email.trim() === (value ?? "")} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
    </Card>
  );
}
