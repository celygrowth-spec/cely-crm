import { requireOwner } from "@/lib/auth";
import { DiscoveryPanel } from "@/components/discovery/admin-panel";

export default async function DiscoveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireOwner();
  return <DiscoveryPanel projectId={id} />;
}
