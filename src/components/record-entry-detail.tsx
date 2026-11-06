"use client";

// Contenu complet d'une entrée, chargé au clic : compte rendu Fireflies, fil d'email, rendez-vous ou texte.
import dynamic from "next/dynamic";
import { linkedCallId, type ActivityEntry } from "@/lib/crm/record-activity";
import { CHANNEL_LABELS, formatDateTime, personName } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { useCompanyCalls, Provenance } from "./record-entry";
import { BookingCard } from "./record-appointments";
import { MailThread } from "./record-mail";
import { Modal, Skeleton } from "./ui";

const CallPanel = dynamic(() => import("./fireflies/call-panel").then((m) => m.CallPanel));

export function EntryDetail({ entry: e, ctx, onClose }: { entry: ActivityEntry; ctx: RecordCtx; onClose: () => void }) {
  const companyId = ctx.detail.company.id;
  const callId = e.call?.id ?? (e.interaction ? linkedCallId(e.interaction) : null);
  const calls = useCompanyCalls(companyId, !!callId);
  const call = e.call ?? calls.data?.find((c) => c.id === callId);
  if (call) return <CallPanel call={call} onClose={onClose} />;

  const mailId = e.mail?.id ?? (typeof e.interaction?.meta?.mail_id === "string" ? e.interaction.meta.mail_id : null);
  const i = e.interaction;
  const person = personName(ctx.detail.people.find((p) => p.id === e.personId));
  return (
    <Modal open onClose={onClose} title={e.title} wide>
      {callId && calls.isLoading && <Skeleton className="h-24 w-full" />}
      {!(callId && calls.isLoading) && (
        <div className="grid gap-3">
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{e.at ? formatDateTime(e.at) : "Date inconnue"}</span>
            {i?.channel && <span>· {CHANNEL_LABELS[i.channel]}</span>}
            {person && <span>· {person}</span>}
            {i && <Provenance source={i.source} origin={i.content_origin} />}
          </p>
          {mailId ? (
            <MailThread companyId={companyId} mailId={mailId} onCompose={(t) => { onClose(); ctx.compose(t); }} />
          ) : (
            i?.content && <p className="rounded-lg bg-surface px-3 py-2 text-sm break-words whitespace-pre-wrap">{i.content}</p>
          )}
          {!mailId && !i?.content && !e.booking && <p className="text-sm text-muted">Aucun compte rendu saisi pour cet échange.</p>}
          {e.booking && <BookingCard b={e.booking} />}
        </div>
      )}
    </Modal>
  );
}
