// CMS › Pages SEO : réglages SEO des pages du site, par chemin.
import { requireAppOwner } from "@/lib/auth";
import { cmsMissingTables } from "@/lib/cms/ready";
import { CmsNotInstalled } from "@/components/cms/not-installed";
import { listPages } from "@/lib/cms/pages-service";
import { PagesView } from "./pages-view";

export const dynamic = "force-dynamic";

export default async function CmsPagesPage() {
  const { supabase } = await requireAppOwner();
  if (await cmsMissingTables(supabase)) return <CmsNotInstalled />;
  return <PagesView pages={await listPages(supabase)} />;
}
