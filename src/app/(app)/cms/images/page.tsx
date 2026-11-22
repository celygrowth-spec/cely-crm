// CMS › Images : images envoyées pour le site (couvertures, partage, corps des articles).
import { requireAppOwner } from "@/lib/auth";
import { cmsMissingTables } from "@/lib/cms/ready";
import { CmsNotInstalled } from "@/components/cms/not-installed";
import { listMedia } from "@/lib/cms/media";
import { MediaView } from "./media-view";

export const dynamic = "force-dynamic";

export default async function CmsImagesPage() {
  const { supabase } = await requireAppOwner();
  if (await cmsMissingTables(supabase)) return <CmsNotInstalled />;
  return <MediaView media={await listMedia(supabase)} />;
}
