import { headers } from "next/headers";
import { Unavailable } from "@/components/rdv/public-bits";
import { appUrl } from "@/lib/appointments/config";
import { AppointmentsNotConfigured } from "@/lib/appointments/secrets";
import { BookingError, getPublicBooking } from "@/lib/appointments/server";
import { ManageView } from "./manage-view";

// Lien privé d'un rendez-vous : le jeton est vérifié côté serveur (HMAC) puis en base (empreinte).
export default async function ManagePage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ action?: string }> }) {
  const { ref } = await params;
  const { action } = await searchParams;
  let booking;
  try {
    booking = await getPublicBooking(ref);
  } catch (e) {
    if (e instanceof AppointmentsNotConfigured || e instanceof BookingError) {
      return <Unavailable title="Service momentanément indisponible" text="Ce rendez-vous ne peut pas être affiché pour le moment. Réessayez un peu plus tard." />;
    }
    throw e;
  }
  if (!booking) return <Unavailable title="Lien invalide" text="Ce lien de rendez-vous n'est pas valide. Vérifiez qu'il a été copié en entier." />;
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = appUrl(host ? `${proto}://${host}` : null);
  // instant de la requête : un rendez-vous commencé ne se modifie plus en ligne (la base le refuse aussi)
  // eslint-disable-next-line react-hooks/purity -- composant serveur rendu à chaque requête
  const past = Date.parse(booking.starts_at) <= Date.now();
  return <ManageView booking={booking} refToken={ref} manageUrl={`${origin}/rdv/gerer/${ref}`} past={past} initialMode={action === "annuler" ? "cancel" : action === "reporter" ? "reschedule" : "view"} />;
}
