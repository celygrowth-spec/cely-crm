// Version intégrable de la page de réservation (widgets « dans la page », « bouton flottant », « lien ou bouton »).
// C'est exactement le même parcours que /rdv/<lien> : mêmes créneaux, même API de réservation, mêmes contrôles.
// Seule cette adresse peut s'afficher dans un autre site (voir next.config.ts).
import { AppointmentsNotConfigured } from "@/lib/appointments/secrets";
import { BookingError, getPublicEvent } from "@/lib/appointments/server";
import { Unavailable } from "@/components/rdv/public-bits";
import { EmbedFrame } from "@/components/rdv/embed-frame";
import { BookingFlow } from "../booking-flow";

export default async function EmbeddedBookingPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const mode = sp.mode === "popup" ? "popup" : "inline";
  let event: Awaited<ReturnType<typeof getPublicEvent>> | "down";
  try {
    event = await getPublicEvent(slug);
  } catch (e) {
    if (!(e instanceof AppointmentsNotConfigured || e instanceof BookingError)) throw e;
    event = "down";
  }
  const content = event === "down"
    ? <Unavailable title="Réservation momentanément indisponible" text="La prise de rendez-vous en ligne n'est pas accessible pour le moment. Réessayez un peu plus tard." />
    : event
      ? <BookingFlow event={event} />
      : <Unavailable title="Réservation indisponible" text="Cette page de réservation n'est plus proposée." />;
  return <EmbedFrame mode={mode}>{content}</EmbedFrame>;
}
