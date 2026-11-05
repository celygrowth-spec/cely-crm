// Rendez-vous d'une fiche (section « Rendez-vous » de la fiche unique)
import { apiRead } from "@/lib/api";
import { companyBookings } from "@/lib/appointments/owner";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => companyBookings(sb, id));
}
