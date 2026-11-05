"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Mail, PlugZap, Send, Unplug } from "lucide-react";
import { MailStatusBadge } from "@/components/mail-status";
import { Badge, Button, Card, Field, Input, Modal, Skeleton, Textarea } from "@/components/ui";
import { mailCall, type MailOverview } from "@/lib/client/mail";
import { apiGet, attempt } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { isEmail, type MailAccount } from "@/lib/mail/types";

const ERRORS: Record<string, string> = {
  config: "Le système mail n'est pas encore configuré.",
  state: "La connexion n'a pas pu être vérifiée. Relancez-la depuis cette page.",
  denied: "Connexion annulée : Google n'a transmis aucune autorisation.",
  scope: "L'autorisation d'envoi n'a pas été accordée. Reconnectez et cochez l'envoi d'emails.",
  refresh: "Google n'a pas fourni d'accès durable. Reconnectez le compte.",
  failed: "La connexion a échoué. Réessayez.",
};
const STATUS: Record<MailAccount["status"], { label: string; tone: "violet" | "danger" | "neutral" }> = {
  connected: { label: "Connecté", tone: "violet" },
  needs_reconnect: { label: "À reconnecter", tone: "danger" },
  disconnected: { label: "Déconnecté", tone: "neutral" },
};

const startUrl = (hint?: string) => `/api/mail/oauth/start${hint ? `?hint=${encodeURIComponent(hint)}` : ""}`;

export function MailSettings({ connected, error }: { connected: boolean; error?: string }) {
  const q = useQuery({ queryKey: ["mail-overview"], queryFn: ({ signal }) => apiGet<MailOverview>("/api/mail/accounts", signal) });
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">{q.error.message} <button className="underline" onClick={() => q.refetch()}>Réessayer</button></p>;
  const data = q.data!;
  const active = data.accounts.find((a) => a.is_default && a.status === "connected");
  const others = data.accounts.filter((a) => a !== active);

  return (
    <>
      {connected && <p className="rounded-lg bg-violet-soft px-3 py-2 text-sm">Gmail est connecté. Envoyez-vous un test pour le vérifier.</p>}
      {error && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{ERRORS[error] ?? ERRORS.failed}</p>}

      {!data.configured ? (
        <Card className="p-4 text-sm">
          <p className="font-semibold">Configuration à terminer</p>
          <p className="mt-1 text-muted">Il manque les réglages Google côté serveur. La marche à suivre est dans docs/mail-configuration.md.</p>
        </Card>
      ) : active ? (
        <ActiveAccount account={active} />
      ) : (
        <Card className="p-4">
          <p className="font-semibold">Connectez votre compte Gmail ou Google Workspace</p>
          <p className="mt-1 text-sm text-muted">Vous vous identifiez chez Google : votre mot de passe n&apos;est jamais demandé ici. Le CRM demande uniquement le droit d&apos;envoyer des emails, pas de lire votre boîte.</p>
          <a href={startUrl()} className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-sm font-semibold text-white"><PlugZap size={14} /> Connecter Gmail</a>
        </Card>
      )}

      {data.configured && others.length > 0 && (
        <Card className="p-4">
          <h2 className="font-display text-base font-bold">Autres comptes</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {others.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{a.email}</span>
                <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                {a.last_error && <span className="w-full text-xs text-danger">{a.last_error}</span>}
                <a href={startUrl(a.email)} className="text-xs font-semibold text-violet-strong underline">Reconnecter</a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Derniers envois</h2>
        <p className="text-xs text-muted">« Accepté par Gmail » ne veut dire ni livré, ni lu : Gmail ne donne pas cette information.</p>
        {!data.recent.length && <p className="mt-2 text-sm text-muted">Aucun envoi pour l&apos;instant.</p>}
        <ul className="mt-2 divide-y divide-line text-sm">
          {data.recent.map((m) => (
            <li key={m.id} className="py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <MailStatusBadge status={m.status} />
                <span className="min-w-0 flex-1 truncate font-semibold">{m.subject || "(sans objet)"}</span>
                <span className="text-xs text-muted">{formatDateTime(m.sent_at ?? m.updated_at)}</span>
              </div>
              <p className="truncate text-xs text-muted">À : {m.to_addrs.join(", ")}</p>
              {m.last_error && <p className="text-xs text-danger">{m.last_error}</p>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function ActiveAccount({ account: a }: { account: MailAccount }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState(a.signature);
  const [testTo, setTestTo] = useState(a.email);
  const [testing, setTesting] = useState(false);
  const inFlight = useRef(false); // deux clics rapprochés arrivent avant le nouveau rendu du bouton
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail-overview"] });
  const post = <T,>(body: unknown) => attempt(() => mailCall<T>("/api/mail/accounts", "POST", body));

  async function disconnect() {
    setBusy(true);
    const r = await post<{ revoked: boolean }>({ op: "disconnect", id: a.id });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.revoked) toast.success("Gmail déconnecté. Plus aucun envoi ne partira.");
    else toast.warning("Plus aucun envoi ne partira, mais Google n'a pas confirmé le retrait de l'accès. Retirez-le aussi sur myaccount.google.com › Sécurité.");
    refresh();
  }
  async function saveSignature() {
    const r = await post({ op: "signature", id: a.id, signature });
    if (!r.ok) return toast.error(r.error);
    toast.success("Signature enregistrée");
    refresh();
  }
  async function test() {
    if (inFlight.current) return;
    inFlight.current = true;
    setTesting(true);
    const r = await post<{ status: string; last_error: string | null }>({ op: "test", to: testTo.trim(), key: crypto.randomUUID() });
    inFlight.current = false;
    setTesting(false);
    refresh();
    if (!r.ok) return toast.error(r.error);
    if (r.data.status === "accepted") toast.success(`Accepté par Gmail. Vérifiez la réception sur ${testTo}.`);
    else toast.error(r.data.last_error ?? "L'envoi n'a pas abouti.");
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Mail size={16} className="text-violet-strong" />
        <span className="min-w-0 flex-1 truncate font-semibold">{a.email}</span>
        <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
      </div>
      <p className="text-xs text-muted">Connecté le {formatDateTime(a.connected_at)} · Autorisation : envoi uniquement. Le CRM ne lit pas votre boîte.</p>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Envoyer un test à" className="min-w-56 flex-1">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        </Field>
        <Button onClick={test} disabled={testing || !isEmail(testTo.trim())}><Send size={14} /> {testing ? "Envoi…" : "Envoyer le test"}</Button>
      </div>

      <Field label="Signature par défaut">
        <Textarea value={signature} onChange={(e) => setSignature(e.target.value)} className="min-h-20" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button onClick={saveSignature} disabled={signature === a.signature}>Enregistrer la signature</Button>
        <a href={startUrl(a.email)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-violet-soft"><PlugZap size={14} /> Reconnecter</a>
        <Button variant="ghost" className="ml-auto" onClick={() => setConfirming(true)}><Unplug size={14} /> Déconnecter</Button>
      </div>

      <Modal open={confirming} onClose={() => setConfirming(false)} title="Déconnecter Gmail ?">
        <p className="text-sm">Les envois s&apos;arrêtent immédiatement et l&apos;accès est retiré chez Google. Les messages en attente sont annulés et ne repartiront pas à la reconnexion. Vos brouillons et l&apos;historique sont conservés.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Annuler</Button>
          <Button variant="danger" disabled={busy} onClick={disconnect}>Déconnecter</Button>
        </div>
      </Modal>
    </Card>
  );
}
