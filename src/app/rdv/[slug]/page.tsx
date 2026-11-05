import { notFound } from "next/navigation";
import { AppointmentsNotConfigured } from "@/lib/appointments/secrets";
import { BookingError, getPublicEvent } from "@/lib/appointments/server";
import { Unavailable } from "@/components/rdv/public-bits";
import { BookingFlow } from "./booking-flow";

export default async function PublicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let event;
  try {
    event = await getPublicEvent(slug);
  } catch (e) {
    if (e instanceof AppointmentsNotConfigured || e instanceof BookingError) {
      return <Unavailable title="Réservation momentanément indisponible" text="La prise de rendez-vous en ligne n'est pas accessible pour le moment. Réessayez un peu plus tard." />;
    }
    throw e;
  }
  if (!event) notFound();
  return <BookingFlow event={event} />;
}
