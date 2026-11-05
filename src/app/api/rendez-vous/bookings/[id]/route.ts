import { apiRead } from "@/lib/api";
import { getBooking } from "@/lib/appointments/owner";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => getBooking(sb, id));
}
