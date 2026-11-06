"use client";

// Comptes rendus Fireflies d'un rendez-vous. Ceux de la fiche se trouvent sous le filtre « Appels » de l'Activité.
import { CallList } from "./fireflies/call-list";

export function BookingCalls({ bookingId }: { bookingId: string }) {
  return <CallList url={`/api/fireflies/calls?booking=${bookingId}`} queryKey={["fireflies-calls", "booking", bookingId]} empty="Aucun compte rendu Fireflies pour ce rendez-vous." />;
}
