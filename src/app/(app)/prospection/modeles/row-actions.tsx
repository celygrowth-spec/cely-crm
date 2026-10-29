"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Trash2 } from "lucide-react";
import { deleteTemplateAction, duplicateTemplateAction } from "@/app/actions";
import { Button } from "@/components/ui";

export function TemplateRowActions({ id }: { id: string }) {
  const router = useRouter();
  return (
    <div className="flex">
      <Button
        size="sm"
        variant="ghost"
        title="Dupliquer"
        onClick={async () => {
          const res = await duplicateTemplateAction(id);
          if (!res.ok) return toast.error(res.error);
          toast.success("Modèle dupliqué");
          router.push(`/prospection/modeles/${res.data}`);
        }}
      >
        <Copy size={14} />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        title="Supprimer"
        onClick={async () => {
          if (!confirm("Supprimer ce modèle ? Les campagnes déjà lancées gardent leur copie des étapes.")) return;
          const res = await deleteTemplateAction(id);
          if (!res.ok) return toast.error(res.error);
          router.refresh();
        }}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}
