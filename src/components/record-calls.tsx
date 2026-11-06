"use client";

// Section « Historique des appels » de la fiche, pour relire le dernier échange avant de rappeler.
import { CallList } from "./fireflies/call-list";

export function RecordCalls({ companyId }: { companyId: string }) {
  return <CallList url={`/api/fireflies/calls?company=${companyId}`} queryKey={["fireflies-calls", "company", companyId]} empty="Aucun appel enregistré pour cette fiche." />;
}

export function BookingCalls({ bookingId }: { bookingId: string }) {
  return <CallList url={`/api/fireflies/calls?booking=${bookingId}`} queryKey={["fireflies-calls", "booking", bookingId]} empty="Aucun compte rendu Fireflies pour ce rendez-vous." />;
}
