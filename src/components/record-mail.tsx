"use client";

// Fil d'un email de la fiche : brouillons, envois et leur état réel.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Paperclip } from "lucide-react";
import { mailOp } from "@/lib/client/mail";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { emailThread } from "@/lib/crm/record-activity";
import { formatDateTime } from "@/lib/format";
import type { MailMessage } from "@/lib/mail/types";
import type { ComposeTarget } from "./mail-compose";
import { MailStatusBadge } from "./mail-status";
import { Button, Skeleton } from "./ui";

/** Le fil d'un email : les messages du même fil Gmail, du plus ancien au plus récent, chargés à l'ouverture. */
export function MailThread({ companyId, mailId, onCompose }: { companyId: string; mailId: string; onCompose: (t: ComposeTarget) => void }) {
  const mail = useQuery({ queryKey: ["company-mail", companyId], queryFn: ({ signal }) => apiGet<MailMessage[]>(`/api/mail/messages?company=${companyId}`, signal) });
  if (mail.isLoading) return <Skeleton className="h-24 w-full" />;
  if (mail.isError) return <p className="text-sm text-danger">{mail.error.message} <button className="underline" onClick={() => mail.refetch()}>Réessayer</button></p>;
  const current = mail.data?.find((m) => m.id === mailId);
  if (!current) return <p className="text-sm text-muted">Cet email n&apos;est plus disponible.</p>;
  return (
    <ul className="space-y-2">
      {emailThread(current, mail.data ?? []).map((m) => <MailRow key={m.id} m={m} companyId={companyId} onCompose={onCompose} />)}
    </ul>
  );
}

function MailRow({ m, companyId, onCompose }: { m: MailMessage; companyId: string; onCompose: (t: ComposeTarget) => void }) {
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  async function act(body: Record<string, unknown>) {
    setBusy(true);
    const r = await attempt(() => mailOp(m.id, body));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    sync(["company-mail", companyId], ["company-timeline", companyId], ["company", companyId]);
  }
  return (
    <li className="row-in rounded-lg border border-line px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <MailStatusBadge status={m.status} />
        <span className="min-w-0 flex-1 truncate font-semibold">{m.subject || "(sans objet)"}</span>
        {!!m.attachments.length && <span className="inline-flex items-center gap-0.5 text-xs text-muted"><Paperclip size={12} />{m.attachments.length}</span>}
        <span className="text-xs text-muted">{formatDateTime(m.sent_at ?? m.updated_at)}</span>
      </div>
      <p className="mt-0.5 truncate text-xs text-muted">À : {m.to_addrs.join(", ") || "—"}</p>
      {m.body_text && <p className="mt-2 text-sm break-words whitespace-pre-wrap">{m.body_text}</p>}
      {m.last_error && <p className="mt-1 text-xs text-danger">{m.last_error}</p>}
      {m.status === "draft" && <Button size="sm" className="mt-1" onClick={() => onCompose({ message: m })}>Reprendre</Button>}
      {m.status === "failed" && (
        <div className="mt-1 flex gap-1">
          <Button size="sm" onClick={() => onCompose({ message: m })}>Reprendre</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ op: "discard" })}>Annuler</Button>
        </div>
      )}
      {m.status === "uncertain" && (
        <div className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs">
          Regardez dans « Messages envoyés » de Gmail, puis indiquez ce que vous y voyez.
          <div className="mt-1 flex gap-1">
            <Button size="sm" disabled={busy} onClick={() => act({ op: "resolve", sent: true })}>Il y est</Button>
            <Button size="sm" disabled={busy} onClick={() => act({ op: "resolve", sent: false })}>Il n&apos;y est pas</Button>
          </div>
        </div>
      )}
    </li>
  );
}
