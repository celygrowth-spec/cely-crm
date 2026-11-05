"use client";

import { Button } from "@/components/ui";
import { useOpenBooking } from "@/components/rdv/booking-detail";

export function OpenBookingButton({ id }: { id: string }) {
  const open = useOpenBooking();
  return <Button size="sm" onClick={() => open(id)}>Détail</Button>;
}
