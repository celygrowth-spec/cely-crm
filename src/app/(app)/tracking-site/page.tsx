// Tracking site : mesure propriétaire de l'acquisition de celygrowth.com (sources, campagnes, pages, prospects,
// SEO, IA, géographie). Les données sont lues côté navigateur, onglet par onglet, par /api/tracking/*.
import { Suspense } from "react";
import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth";
import { PageSkeleton } from "@/components/ui";
import { TrackingView } from "@/components/tracking/tracking-view";

export const metadata: Metadata = { title: "Tracking site" };

export default async function TrackingSitePage() {
  await requireOwner();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TrackingView />
    </Suspense>
  );
}
