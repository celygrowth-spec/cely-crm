"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, Copy, Pause, Play, Zap } from "lucide-react";
import { duplicateCampaignAction, setCampaignStatusAction } from "@/app/prospection-actions";
import { CampaignStatusBadge, ChannelChip } from "@/components/prospection/bits";
import { Button, cn } from "@/components/ui";
import type { CampaignOverview } from "@/lib/prospection/service";

const TABS = [
  { seg: "", label: "Vue d'ensemble" },
  { seg: "sequence", label: "Séquence" },
  { seg: "prospects", label: "Prospects" },
  { seg: "preparation", label: "Préparation" },
  { seg: "activite", label: "Activité" },
  { seg: "parametres", label: "Paramètres" },
];

export function CampaignHeader({ c }: { c: CampaignOverview }) {
  const pathname = usePathname();
  const router = useRouter();
  const base = `/prospection/campagnes/${c.id}`;
  const current = pathname.slice(base.length).replace(/^\//, "").split("/")[0];

  async function status(s: CampaignOverview["status"], msg: string) {
    const r = await setCampaignStatusAction(c.id, s);
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    router.refresh();
  }

  return (
    <div className="sticky top-0 z-30 -mx-4 -mt-5 mb-4 border-b border-line bg-white/95 px-4 pt-3 backdrop-blur md:-mx-8 md:-mt-7 md:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/prospection/campagnes" className="rounded p-1 text-muted hover:bg-surface" aria-label="Retour aux campagnes"><ChevronLeft size={16} /></Link>
        <h1 className="font-display text-xl font-extrabold">{c.name}</h1>
        <CampaignStatusBadge status={c.status} />
        <div className="flex gap-1">{c.channels.map((ch) => <ChannelChip key={ch} channel={ch} />)}</div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="mr-2 hidden text-xs text-muted lg:inline">
            <strong className="text-ink">{c.enrolled}</strong> inscrites · <strong className="text-ink">{c.in_progress}</strong> en cours ·{" "}
            <strong className="text-ink">{c.due_today}</strong> aujourd&apos;hui · <strong className={c.overdue ? "text-danger" : "text-ink"}>{c.overdue}</strong> en retard ·{" "}
            <strong className="text-ink">{c.replied}</strong> réponses
          </span>
          {c.status === "active" && (c.due_today + c.overdue > 0) && (
            <Link href={`/prospection/focus?campagne=${c.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-semibold text-white hover:bg-violet-strong">
              <Zap size={14} /> Commencer la session
            </Link>
          )}
          {c.status === "active" && <Button size="sm" onClick={() => status("paused", "Campagne en pause : ses actions ne sont plus proposées")}><Pause size={13} /> Pause</Button>}
          {c.status === "paused" && <Button size="sm" onClick={() => status("active", "Campagne reprise")}><Play size={13} /> Reprendre</Button>}
          {c.status === "draft" && c.to_prepare > 0 && (
            <Link href={`${base}/preparation`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-semibold text-white hover:bg-violet-strong">Préparer et activer</Link>
          )}
          <Button
            size="sm"
            variant="ghost"
            title="Dupliquer (structure et contenus, sans prospects)"
            onClick={async () => {
              const r = await duplicateCampaignAction(c.id);
              if (!r.ok) return toast.error(r.error);
              router.push(`/prospection/campagnes/${r.data}/sequence`);
            }}
          >
            <Copy size={13} />
          </Button>
        </div>
      </div>
      <nav className="mt-2 flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const active = current === t.seg;
          const count = t.seg === "preparation" ? c.to_prepare : t.seg === "prospects" ? c.enrolled : null;
          return (
            <Link
              key={t.seg}
              href={t.seg ? `${base}/${t.seg}` : base}
              className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 font-label text-[13px] font-semibold whitespace-nowrap", active ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {t.label}
              {count ? <span className="rounded-full bg-surface px-1.5 text-[10px]">{count}</span> : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
