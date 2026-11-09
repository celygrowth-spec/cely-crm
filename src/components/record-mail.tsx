"use client";

// Fil d'un email de la fiche : brouillons, envois et leur état réel. Un email accepté se relit tel
// qu'il est parti (variables résolues, signature comprise) et on peut y répondre dans le même fil.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Paperclip, Reply } from "lucide-react";
import { mailOp, type MailOverview } from "@/lib/client/mail";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { emailThread } from "@/lib/crm/record-activity";
import { formatDateTime } from "@/lib/format";
import { renderEmailHtml, textToHtml } from "@/lib/mail/render";
import type { MailMessage } from "@/lib/mail/types";
import type { ComposeTarget } from "./mail-compose";
import { MailStatusBadge } from "./mail-status";
import { Button, Skeleton } from "./ui";

/** Le fil d'un email : les messages du même fil Gmail, du plus ancien au plus récent, chargés à l'ouverture. */
export function MailThread({ companyId, mailId, onCompose }: { companyId: string; mailId: string; onCompose: (t: ComposeTarget) => void }) {
  const mail = useQuery({ queryKey: ["company-mail", companyId], queryFn: ({ signal }) => apiGet<MailMessage[]>(`/api/mail/messages?company=${companyId}`, signal) });
  const overview = useQuery({ queryKey: ["mail-overview"], queryFn: ({ signal }) => apiGet<MailOverview>("/api/mail/accounts", signal) });
  if (mail.isLoading) return <Skeleton className="h-24 w-full" />;
  if (mail.isError) return <p className="text-sm text-danger">{mail.error.message} <button className="underline" onClick={() => mail.refetch()}>Réessayer</button></p>;
  const current = mail.data?.find((m) => m.id === mailId);
  if (!current) return <p className="text-sm text-muted">Cet email n&apos;est plus disponible.</p>;
  const thread = emailThread(current, mail.data ?? []);
  const fromOf = (m: MailMessage) => overview.data?.accounts.find((a) => a.id === m.account_id)?.email ?? null;
  const last = [...thread].reverse().find((m) => m.status === "accepted");
  return (
    <div className="space-y-2" data-mail-thread>
      <ul className="space-y-2">
        {thread.map((m) => <MailRow key={m.id} m={m} from={fromOf(m)} companyId={companyId} onCompose={onCompose} />)}
      </ul>
      {last && (
        <Button size="sm" onClick={() => onCompose({ replyTo: last })}><Reply size={14} /> Répondre dans ce fil</Button>
      )}
    </div>
  );
}

function MailRow({ m, from, companyId, onCompose }: { m: MailMessage; from: string | null; companyId: string; onCompose: (t: ComposeTarget) => void }) {
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  async function act(body: Record<string, unknown>) {
    setBusy(true);
    const r = await attempt(() => mailOp<MailMessage>(m.id, body));
    setBusy(false);
    if (!r.ok) { toast.error(r.error); return null; }
    sync(["company-mail", companyId], ["company-timeline", companyId], ["company", companyId]);
    return r.data;
  }
  // un envoi échoué redevient un brouillon (tel qu'il avait été écrit, variables comprises) avant d'être repris
  async function resume() {
    const reopened = await act({ op: "reopen" });
    if (reopened) onCompose({ message: reopened });
  }
  const sent = m.status === "accepted";
  return (
    <li className="row-in rounded-lg border border-line px-3 py-2 text-sm" data-mail-row={m.status}>
      <div className="flex flex-wrap items-center gap-2">
        <MailStatusBadge status={m.status} />
        <span className="min-w-0 flex-1 truncate font-semibold">{m.subject || "(sans objet)"}</span>
        <span className="text-xs text-muted">{formatDateTime(m.sent_at ?? m.updated_at)}</span>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted">
        {from && <><dt>De</dt><dd className="truncate text-ink">{from}</dd></>}
        <dt>À</dt><dd className="truncate text-ink">{m.to_addrs.join(", ") || "—"}</dd>
        {!!m.cc_addrs.length && <><dt>Cc</dt><dd className="truncate text-ink">{m.cc_addrs.join(", ")}</dd></>}
        {!!m.bcc_addrs.length && <><dt>Cci</dt><dd className="truncate text-ink">{m.bcc_addrs.join(", ")}</dd></>}
      </dl>
      {!!m.attachments.length && (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Pièces jointes">
          {m.attachments.map((a) => (
            <li key={a.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-xs"><Paperclip size={11} />{a.name}</li>
          ))}
        </ul>
      )}
      {sent && full ? (
        <iframe title="Email tel qu'envoyé" sandbox="" srcDoc={renderEmailHtml(m.body_html ?? textToHtml(m.body_text), m.signature)} className="mt-2 h-80 w-full rounded-lg border border-line bg-white" data-mail-full />
      ) : (
        m.body_text && <p className="mt-2 line-clamp-4 text-sm break-words whitespace-pre-wrap">{m.body_text}</p>
      )}
      {sent && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)}>{full ? <><EyeOff size={13} /> Réduire</> : <><Eye size={13} /> Message complet</>}</Button>
          <span className="text-xs text-muted">Accepté par Gmail : remis pour envoi, ce qui ne dit ni s&apos;il est arrivé ni s&apos;il a été lu.</span>
        </div>
      )}
      {m.last_error && <p className="mt-1 text-xs text-danger">{m.last_error}</p>}
      {m.status === "draft" && <Button size="sm" className="mt-1" onClick={() => onCompose({ message: m })}>Reprendre</Button>}
      {m.status === "failed" && (
        <div className="mt-1 flex gap-1">
          <Button size="sm" disabled={busy} onClick={() => void resume()}>Reprendre le brouillon</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ op: "discard" })}>Annuler</Button>
        </div>
      )}
      {m.status === "uncertain" && (
        <div className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs">
          Gmail n&apos;a pas répondu clairement. Regardez dans « Messages envoyés » de Gmail, puis indiquez ce que vous y voyez :
          rien n&apos;est renvoyé automatiquement, pour ne jamais envoyer deux fois.
          <div className="mt-1 flex gap-1">
            <Button size="sm" disabled={busy} onClick={() => void act({ op: "resolve", sent: true })}>Il y est</Button>
            <Button size="sm" disabled={busy} onClick={() => void act({ op: "resolve", sent: false })}>Il n&apos;y est pas</Button>
          </div>
        </div>
      )}
    </li>
  );
}
