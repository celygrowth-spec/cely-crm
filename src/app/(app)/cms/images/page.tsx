// CMS › Images : images envoyées pour le site (couvertures, partage, corps des articles).
import { requireAppOwner } from "@/lib/auth";
import { listMedia } from "@/lib/cms/media";
import { MediaView } from "./media-view";

export const dynamic = "force-dynamic";

export default async function CmsImagesPage() {
  const { supabase } = await requireAppOwner();
  return <MediaView media={await listMedia(supabase)} />;
}
