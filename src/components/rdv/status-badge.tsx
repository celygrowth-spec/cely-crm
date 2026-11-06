"use client";

import { DISPLAY_STATUS_LABELS, type DisplayStatus } from "@/lib/appointments/types";
import { Badge } from "../ui";

export const STATUS_TONE: Record<DisplayStatus, "violet" | "warning" | "success" | "danger" | "neutral"> = {
  a_venir: "violet",
  a_renseigner: "warning",
  done: "success",
  no_show: "danger",
  cancelled: "neutral",
  pending: "neutral",
};

export function StatusBadge({ s }: { s: DisplayStatus }) {
  return <Badge tone={STATUS_TONE[s]}>{DISPLAY_STATUS_LABELS[s]}</Badge>;
}
