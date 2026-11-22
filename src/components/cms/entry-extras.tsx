"use client";

// Actions secondaires d'un article : export .md (frontmatter et contenu).
import { Download } from "lucide-react";
import type { CmsEntry } from "@/lib/cms/types";

export function EntryExtras({ entry }: { entry: CmsEntry }) {
  return (
    <a href={`/api/cms/export?id=${entry.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-semibold hover:border-violet" data-export-one>
      <Download size={14} /> Exporter .md
    </a>
  );
}
