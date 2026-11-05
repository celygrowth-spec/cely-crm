"use client";

// Emails de la fiche : brouillons, envois et leur état réel.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Paperclip, PenLine } from "lucide-react";
import { mailOp } from "@/lib/client/mail";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import type { MailMessage } from "@/lib/mail/types";
import type { ComposeTarget } from "./mail-compose";
import { MailStatusBadge } from "./mail-status";
import { Button, Skeleton } from "./ui";

export function RecordMail({ companyId, onCompose }: { companyId: string; onCompose: (t: ComposeTarget) => void }) {
  const mail = useQuery({ queryKey: ["company-mail", companyId], queryFn: ({ signal }) => apiGet<MailMessage[]>(`/api/mail/messages?company=${companyId}`, signal) });
  return (
    <div className="space-y-2">
      <Button size="sm" onClick={() => onCompose({})}><PenLine size={13} /> Écrire un email</Button>
      {mail.isLoading && <Skeleton className="h-12 w-full" />}
      {mail.isError && <p className="text-sm text-danger">{mail.error.message} <button className="underline" onClick={() => mail.refetch()}>Réessayer</button></p>}
      {mail.data && !mail.data.length && <p className="text-sm text-muted">Aucun email envoyé depuis le CRM sur cette fiche.</p>}
      <ul className="space-y-1">
        {mail.data?.map((m) => <MailRow key={m.id} m={m} companyId={companyId} onCompose={onCompose} />)}
      </ul>
    </div>
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
