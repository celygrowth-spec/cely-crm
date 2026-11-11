"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Paperclip } from "lucide-react";
import { linkInboundAction } from "@/app/inbox-actions";
import { Button } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export type InboundRow = {
  id: string; from_addr: string; subject: string; body_text: string; received_at: string;
  link_candidates: { company_id: string; name: string; person_id: string }[] | null;
  attachments_meta: { name: string }[] | null;
};

export function InboundToLink({ rows }: { rows: InboundRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function link(r: InboundRow, c: { company_id: string; name: string; person_id: string }) {
    setBusy(r.id);
    const res = await linkInboundAction(r.id, c.company_id, c.person_id);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Email rattaché à ${c.name}`);
    router.refresh();
  }
  return (
    <ul className="space-y-2" data-inbound-to-link>
      {rows.map((r) => (
        <li key={r.id} className="rounded-xl border border-line p-3">
          <p className="text-sm"><strong>{r.from_addr}</strong> <span className="text-xs text-muted">· {formatDateTime(r.received_at)}</span></p>
          <p className="text-sm font-semibold">{r.subject || "(sans objet)"}</p>
          <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-muted">{r.body_text}</p>
          {!!r.attachments_meta?.length && <p className="mt-1 text-xs text-muted"><Paperclip size={11} className="inline" /> {r.attachments_meta.map((a) => a.name).join(", ")} (à ouvrir dans Gmail)</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(r.link_candidates ?? []).map((c) => (
              <Button key={c.company_id} size="sm" disabled={busy === r.id} onClick={() => void link(r, c)}>Rattacher à {c.name}</Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
