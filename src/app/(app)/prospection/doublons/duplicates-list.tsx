"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { dismissDuplicateAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";

export type Pair = { company_a: string; name_a: string; company_b: string; name_b: string; strength: "exact" | "similar"; reasons: string[] };

export function DuplicatesList({ pairs }: { pairs: Pair[] }) {
  const router = useRouter();
  const { openCompany } = useCrm();
  return (
    <div className="max-w-4xl">
      <PageHeader title="Doublons à vérifier" description="Aucune fusion n'est automatique : vérifiez, puis fusionnez ou marquez comme distinctes." />
      {!pairs.length ? (
        <EmptyState title="Aucun doublon détecté" description="Les rapprochements par domaine, email, LinkedIn ou nom proche apparaîtront ici." />
      ) : (
        <ul className="space-y-2">
          {pairs.map((p) => (
            <li key={`${p.company_a}-${p.company_b}`} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="font-semibold hover:text-violet-strong" onClick={() => openCompany(p.company_a)}>{p.name_a}</button>
                  <span className="text-muted">↔</span>
                  <button className="font-semibold hover:text-violet-strong" onClick={() => openCompany(p.company_b)}>{p.name_b}</button>
                  <Badge tone={p.strength === "exact" ? "danger" : "warning"}>{p.strength === "exact" ? "Correspondance forte" : "À vérifier"}</Badge>
                </div>
                <div className="flex gap-1">
                  <Link href={`/prospection/doublons/fusion?a=${p.company_a}&b=${p.company_b}`} className="inline-flex h-7 items-center rounded-lg bg-ink px-2.5 text-xs font-semibold text-white hover:bg-violet-strong">
                    Comparer et fusionner
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const r = await dismissDuplicateAction(p.company_a, p.company_b);
                      if (!r.ok) return toast.error(r.error);
                      toast.success("Marquées comme entreprises distinctes");
                      router.refresh();
                    }}
                  >
                    Pas un doublon
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted">{p.reasons.join(" · ")}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
