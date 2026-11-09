"use client";

// Données et ligne communes à l'Aperçu et à l'onglet Activité. Les requêtes réutilisent les clés existantes :
// ce qu'une section a déjà chargé sert aussitôt à l'autre.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Bot, Calendar, CheckCircle2, ExternalLink, Inbox, Mail, Phone, Send, StickyNote } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import type { Booking } from "@/lib/appointments/types";
import { buildActivity, linkedCallId, type ActivityEntry } from "@/lib/crm/record-activity";
import type { Call } from "@/lib/fireflies/types";
import { CHANNEL_LABELS, formatDateTime, personName } from "@/lib/format";
import type { MailMessage } from "@/lib/mail/types";
import type { RecordCtx } from "./company-record";
import { MailStatusBadge } from "./mail-status";
import { StatusBadge } from "./rdv/status-badge";
import { Badge } from "./ui";

export const useCompanyCalls = (companyId: string, enabled = true) =>
  useQuery({ queryKey: ["fireflies-calls", "company", companyId], queryFn: ({ signal }) => apiGet<Call[]>(`/api/fireflies/calls?company=${companyId}`, signal), enabled });
export const useCompanyMails = (companyId: string, enabled = true) =>
  useQuery({ queryKey: ["company-mail", companyId], queryFn: ({ signal }) => apiGet<MailMessage[]>(`/api/mail/messages?company=${companyId}`, signal), enabled });
export const useCompanyBookings = (companyId: string) =>
  useQuery({ queryKey: ["appt-company", companyId], queryFn: ({ signal }) => apiGet<Booking[]>(`/api/fiches/${companyId}/rendez-vous`, signal) });

/** `full` : aussi les emails et tous les appels. L'Aperçu ne charge les appels que si une activité y renvoie. */
export function useActivityEntries(ctx: RecordCtx, full: boolean) {
  const { company, interactions, tasks } = ctx.detail;
  const hasLinkedCall = interactions.some((i) => linkedCallId(i));
  const calls = useCompanyCalls(company.id, full || hasLinkedCall);
  const mails = useCompanyMails(company.id, full);
  const bookings = useCompanyBookings(company.id);
  const entries = useMemo(
    () => buildActivity({ interactions, tasks, calls: calls.data, mails: mails.data, bookings: bookings.data }),
    [interactions, tasks, calls.data, mails.data, bookings.data],
  );
  const failed = [calls, mails, bookings].filter((q) => q.isError);
  return {
    entries,
    bookings: bookings.data ?? [],
    loading: ctx.timelineLoading,
    failed: failed.length > 0,
    retry: () => failed.forEach((q) => q.refetch()),
  };
}

function EntryIcon({ e }: { e: ActivityEntry }) {
  if (e.type === "note") return <StickyNote size={13} />;
  if (e.type === "task") return <CheckCircle2 size={13} />;
  if (e.call || e.type === "call") return <Phone size={13} />;
  if (e.type === "meeting") return <Calendar size={13} />;
  if (e.interaction?.kind === "message_in") return <Inbox size={13} />;
  return e.mail ? <Mail size={13} /> : <Send size={13} />;
}

export function Provenance({ source, origin }: { source?: string; origin?: string }) {
  return (
    <>
      {source === "claude" && <span className="inline-flex items-center gap-0.5 text-muted"><Bot size={11} /> via Claude</span>}
      {origin === "claude_suggestion" && <span className="text-muted">· texte rédigé par Claude</span>}
      {source === "import" && <span className="text-muted">· import</span>}
    </>
  );
}

export function EntryRow({ entry: e, ctx }: { entry: ActivityEntry; ctx: RecordCtx }) {
  const person = personName(ctx.detail.people.find((p) => p.id === e.personId));
  const i = e.interaction;
  const notSent = e.mail && e.mail.status !== "accepted";
  const meta = i?.meta as { campaign_name?: string; step_name?: string } | undefined;
  return (
    <div className="row-in relative">
      <button type="button" onClick={() => ctx.openEntry(e)} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface">
        <span className={`mt-0.5 shrink-0 rounded-full border border-line bg-white p-1 ${i?.kind === "message_in" ? "text-success" : "text-violet-strong"}`}><EntryIcon e={e} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 text-sm font-semibold break-words text-ink">{e.title}</span>
            {notSent && e.mail && <MailStatusBadge status={e.mail.status} />}
            {e.booking && !i && <StatusBadge s={e.booking.display_status} />}
            {e.call && <Badge tone="violet">Fireflies</Badge>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{e.at ? formatDateTime(e.at) : "Date inconnue"}</span>
            {i?.channel && !e.call && <span>· {CHANNEL_LABELS[i.channel]}</span>}
            {person && <span>· {person}</span>}
            {e.type === "email" && e.mail && e.mail.status === "accepted" && (
              <span className="min-w-0 truncate">· À {e.mail.to_addrs.join(", ")}{e.mail.attachments.length ? ` · ${e.mail.attachments.length} pièce${e.mail.attachments.length > 1 ? "s" : ""} jointe${e.mail.attachments.length > 1 ? "s" : ""}` : ""}</span>
            )}
            {meta?.campaign_name && <span>· {meta.campaign_name}{meta.step_name ? ` › ${meta.step_name}` : ""}</span>}
            {i && <Provenance source={i.source} origin={i.content_origin} />}
          </span>
          {e.preview ? (
            <span className="mt-0.5 line-clamp-2 text-sm wrap-anywhere whitespace-pre-line text-muted">{e.preview}</span>
          ) : e.type === "call" && !e.call ? (
            <span className="mt-0.5 block text-xs text-muted">Sans compte rendu</span>
          ) : null}
        </span>
      </button>
      {e.booking?.meeting_url && e.booking.display_status === "a_venir" && (
        <a href={e.booking.meeting_url} target="_blank" rel="noopener noreferrer" className="absolute top-2 right-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-strong hover:underline">
          Rejoindre <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}
