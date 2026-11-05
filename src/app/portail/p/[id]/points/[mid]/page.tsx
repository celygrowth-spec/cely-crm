import Link from "next/link";
import { notFound } from "next/navigation";
import { portalLoad } from "@/lib/projects/portal-load";
import type { PortalMeetingDetail } from "@/lib/projects/types";
import { MeetingDetail } from "@/components/portal/meeting-detail";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function MeetingPage({ params }: { params: Promise<{ id: string; mid: string }> }) {
  const { id, mid } = await params;
  if (!UUID_RE.test(mid)) notFound();
  const m = await portalLoad<PortalMeetingDetail>("portal_meeting", { p_project: id, p_meeting: mid });
  return (
    <div className="space-y-4">
      <Link href={`/portail/p/${id}`} className="text-sm font-semibold text-muted hover:text-ink">← Vue d&apos;ensemble</Link>
      <MeetingDetail m={m} />
    </div>
  );
}
