import { MAIL_STATUS_LABELS, type MailStatus } from "@/lib/mail/types";
import { Badge } from "./ui";

const TONES: Partial<Record<MailStatus, "violet" | "danger" | "neutral">> = { accepted: "violet", failed: "danger", uncertain: "danger" };

export function MailStatusBadge({ status }: { status: MailStatus }) {
  return <Badge tone={TONES[status] ?? "neutral"}>{MAIL_STATUS_LABELS[status]}</Badge>;
}
