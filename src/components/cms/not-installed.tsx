// Message affiché quand la base reliée n'a pas encore les tables du CMS.
import { EmptyState } from "@/components/ui";

export function CmsNotInstalled() {
  return (
    <div className="mx-auto max-w-3xl" data-cms-not-installed>
      <EmptyState
        title="CMS pas encore installé sur cette base"
        description="Les migrations du CMS (20261127100100 à 20261127100500, voir docs/cms.md) ne sont pas appliquées sur la base Supabase reliée à cet environnement."
      />
    </div>
  );
}
