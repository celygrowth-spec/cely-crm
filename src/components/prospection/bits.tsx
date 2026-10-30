"use client";

// Icônes de canaux et badges sémantiques de la prospection.
import { CheckSquare, Eye, Mail, MessageSquare, Phone, ThumbsUp, UserPlus } from "lucide-react";
import type { CampaignStatus, Outcome, ParticipantStatus } from "@/lib/prospection/service";
import { STEP_META, type StepType } from "@/lib/prospection/steps";
import { Badge, cn } from "../ui";

export function LinkedinGlyph({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

const STEP_STYLE: Record<StepType, { bg: string; fg: string }> = {
  linkedin_invite: { bg: "bg-[#e8f1fb]", fg: "text-[#0a66c2]" },
  linkedin_message: { bg: "bg-[#e8f1fb]", fg: "text-[#0a66c2]" },
  linkedin_visit: { bg: "bg-[#e8f1fb]", fg: "text-[#0a66c2]" },
  linkedin_interaction: { bg: "bg-[#e8f1fb]", fg: "text-[#0a66c2]" },
  email: { bg: "bg-violet-soft", fg: "text-violet-strong" },
  call: { bg: "bg-emerald-50", fg: "text-emerald-700" },
  task: { bg: "bg-amber-50", fg: "text-amber-700" },
};

export function StepIcon({ type, size = 14 }: { type: StepType; size?: number }) {
  const s = STEP_STYLE[type];
  const inner = (() => {
    switch (type) {
      case "linkedin_invite": return <UserPlus size={size} />;
      case "linkedin_message": return <MessageSquare size={size} />;
      case "linkedin_visit": return <Eye size={size} />;
      case "linkedin_interaction": return <ThumbsUp size={size} />;
      case "email": return <Mail size={size} />;
      case "call": return <Phone size={size} />;
      default: return <CheckSquare size={size} />;
    }
  })();
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center rounded-md", s.bg, s.fg)} style={{ width: size + 12, height: size + 12 }} title={STEP_META[type].label}>
      {inner}
      {STEP_META[type].channel === "linkedin" && (
        <span className="absolute -right-1 -bottom-1 rounded-sm bg-white p-[1px] text-[#0a66c2]"><LinkedinGlyph size={8} /></span>
      )}
    </span>
  );
}

export function ChannelChip({ channel }: { channel: string }) {
  const map: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    linkedin: { label: "LinkedIn", icon: <LinkedinGlyph size={11} />, cls: "text-[#0a66c2] bg-[#e8f1fb] border-[#cfe2f6]" },
    email: { label: "Email", icon: <Mail size={11} />, cls: "text-violet-strong bg-violet-soft border-violet-line" },
    phone: { label: "Appel", icon: <Phone size={11} />, cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
    other: { label: "Tâche", icon: <CheckSquare size={11} />, cls: "text-amber-700 bg-amber-50 border-amber-200" },
  };
  const m = map[channel] ?? map.other;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-label text-[10px] font-semibold", m.cls)} title={m.label}>
      {m.icon}
      {m.label}
    </span>
  );
}

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: "neutral" | "violet" | "success" | "warning" | "danger" | "ink"; dot: string }> = {
  draft: { label: "Brouillon", tone: "neutral", dot: "bg-muted" },
  active: { label: "Active", tone: "success", dot: "bg-success" },
  paused: { label: "En pause", tone: "warning", dot: "bg-amber-500" },
  finished: { label: "Terminée", tone: "violet", dot: "bg-violet" },
  archived: { label: "Archivée", tone: "neutral", dot: "bg-line" },
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const s = CAMPAIGN_STATUS[status];
  return (
    <Badge tone={s.tone}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </Badge>
  );
}

// Statut d'exécution (où en est la séquence pour ce participant)
export const EXEC_STATUS: Record<ParticipantStatus, { label: string; tone: "neutral" | "violet" | "success" | "warning" | "danger" | "ink" }> = {
  a_preparer: { label: "À préparer", tone: "neutral" },
  a_contacter: { label: "À contacter", tone: "violet" },
  en_cours: { label: "En cours", tone: "violet" },
  a_repondu: { label: "A répondu · en pause", tone: "success" },
  termine: { label: "Séquence terminée", tone: "neutral" },
  arrete: { label: "Arrêté", tone: "neutral" },
};

// Résultat commercial (ce que la prospection a donné)
export const OUTCOME: Record<Outcome, { label: string; tone: "neutral" | "violet" | "success" | "warning" | "danger" | "ink" }> = {
  none: { label: "—", tone: "neutral" },
  replied: { label: "A répondu", tone: "warning" },
  interested: { label: "Intéressé", tone: "success" },
  meeting: { label: "Rendez-vous", tone: "ink" },
  not_interested: { label: "Pas intéressé", tone: "danger" },
  do_not_contact: { label: "Ne plus contacter", tone: "danger" },
};

export function ExecBadge({ status }: { status: ParticipantStatus }) {
  const s = EXEC_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  if (outcome === "none") return <span className="text-muted">—</span>;
  const s = OUTCOME[outcome];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Indicateur chiffré compact, cliquable vers une liste filtrée. */
export function Stat({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: string; href?: string; tone?: "danger" | "success" }) {
  const body = (
    <>
      <p className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className={cn("mt-0.5 font-display text-2xl font-extrabold tabular-nums", tone === "danger" && "text-danger", tone === "success" && "text-success")}>{value}</p>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </>
  );
  return href ? (
    <a href={href} className="block rounded-lg border border-line bg-white px-3 py-2 transition-colors hover:border-violet hover:bg-violet-soft/40">{body}</a>
  ) : (
    <div className="rounded-lg border border-line bg-white px-3 py-2">{body}</div>
  );
}
