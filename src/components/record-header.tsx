"use client";

// En-tête commun à toute la fiche : qui, où j'en suis, contact principal, actions. Reste visible au défilement.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Ban, CheckSquare, ChevronDown, ExternalLink, FileUp, Mail, Maximize2, MessageSquarePlus, MoreHorizontal, Pencil, Phone, Plus, Sparkles, StickyNote, Timer, UserRound, X } from "lucide-react";
import { RecordDealClosing } from "./deal-closing";
import { useTimer } from "./time/timer";
import { useCompanyMails } from "./record-entry";
import { formatDateTime } from "@/lib/format";
import { setArchivedAction } from "@/app/actions";
import { attempt } from "@/lib/client/query";
import type { ProspectStatus } from "@/lib/crm/types";
import { PROSPECT_STATUS_LABELS, personName } from "@/lib/format";
import { useCrm } from "./app-shell";
import type { RecordCtx, RecordTab } from "./company-record";
import { useMoveCompany } from "./use-move-company";
import { Badge, Button, SaveIndicator, cn } from "./ui";
import { TrashButton } from "./trash/trash-button";

const TABS: { key: RecordTab; label: string }[] = [
  { key: "overview", label: "Aperçu" },
  { key: "activity", label: "Activité" },
  { key: "details", label: "Détails" },
  { key: "diagnostic", label: "Diagnostic" },
];

/** Ferme au clic extérieur et à Échap, sans que Échap ne ferme aussi le panneau de la fiche. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);
  return ref;
}

function Popover({ label, trigger, triggerClass, className, align, children }: { label: string; trigger: ReactNode; triggerClass: string; className?: string; align: "left" | "right"; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className={cn("relative min-w-0", className)}>
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)} className={triggerClass}>{trigger}</button>
      {open && (
        <div className={cn("fade-in absolute top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-white p-1 shadow-lg", align === "right" ? "right-0" : "max-md:right-0 md:left-0")}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, tone }: { icon: typeof Mail; children: ReactNode; onClick: () => void; tone?: "danger" }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface", tone === "danger" ? "text-danger" : "text-ink")}>
      <Icon size={14} className="shrink-0 text-muted" /> {children}
    </button>
  );
}

const fieldTrigger = "inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink hover:border-violet";

function StageControl({ ctx }: { ctx: RecordCtx }) {
  const { pipelines } = useCrm();
  const move = useMoveCompany(ctx);
  const c = ctx.detail.company;
  const selectCls = "h-8 max-w-[45vw] truncate sm:max-w-52 rounded-lg border bg-white pr-6 pl-2.5 text-xs font-semibold text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none";
  if (!c.pipeline_id) {
    return (
      <select
        value={c.prospect_status}
        onChange={(e) => ctx.patch({ prospect_status: e.target.value as ProspectStatus })}
        className={cn(selectCls, "border-line")}
        aria-label="Statut de prospection"
      >
        {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>Prospection : {v}</option>)}
      </select>
    );
  }
  return (
    <>
      <select
        value={c.stage_id ?? ""}
        onChange={(e) => move(e.target.value)}
        disabled={c.deal_status !== "open"}
        data-stage-locked={c.deal_status !== "open" || undefined}
        title={c.deal_status !== "open" ? `${c.pipeline?.name ?? ""} › ${c.stage?.name ?? "—"} — opportunité clôturée : « Rouvrir l'opportunité » pour changer d'étape` : `${c.pipeline?.name ?? ""} › ${c.stage?.name ?? "—"}`}
        className={cn(selectCls, "border-violet-line bg-violet-soft text-violet-strong")}
        aria-label="Étape du pipeline"
      >
        <option value="">Hors pipeline</option>
        {pipelines.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
      <RecordDealClosing ctx={ctx} />
    </>
  );
}

function ContactControl({ ctx }: { ctx: RecordCtx }) {
  const { people } = ctx.detail;
  const p = people.find((x) => x.is_primary) ?? people[0];
  if (!p) {
    return <button type="button" onClick={() => ctx.go("details", { section: "company" })} className={cn(fieldTrigger, "font-medium text-muted")}><Plus size={13} /> Ajouter un contact</button>;
  }
  const others = people.length - 1;
  return (
    <Popover
      label={`Coordonnées de ${personName(p)}`}
      align="left"
      className="min-w-40 flex-1 basis-0 sm:flex-none sm:basis-auto"
      triggerClass={cn(fieldTrigger, "w-full")}
      trigger={<><UserRound size={13} className="shrink-0 text-muted" /><span className="truncate">{personName(p)}{p.title && <span className="font-normal text-muted"> · {p.title}</span>}</span>{others > 0 && <span className="shrink-0 font-normal text-muted">+{others}</span>}<ChevronDown size={12} className="shrink-0 text-muted" /></>}
    >
      {(close) => (
        <div className="text-sm">
          <p className="px-2.5 pt-2 font-semibold break-words">{personName(p)}</p>
          {p.title && <p className="px-2.5 text-xs text-muted">{p.title}</p>}
          <div className="mt-1">
            {p.email && <MenuItem icon={Mail} onClick={() => { close(); ctx.compose({ personId: p.id, to: p.email }); }}><span className="truncate">{p.email}</span></MenuItem>}
            {p.phone && <a href={`tel:${p.phone}`} className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface"><Phone size={14} className="text-muted" /> {p.phone}</a>}
            {p.linkedin_url && (
              <a href={/^https?:/.test(p.linkedin_url) ? p.linkedin_url : `https://${p.linkedin_url}`} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface">
                <ExternalLink size={14} className="text-muted" /> LinkedIn
              </a>
            )}
            {!p.email && !p.phone && !p.linkedin_url && <p className="px-2.5 py-2 text-xs text-muted">Aucune coordonnée renseignée.</p>}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            <MenuItem icon={UserRound} onClick={() => { close(); ctx.go("details", { section: "company" }); }}>{others > 0 ? `Voir les ${people.length} personnes` : "Gérer les personnes"}</MenuItem>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function RecordHeader({ ctx, tab, onClose, page, save, onPreload }: { ctx: RecordCtx; tab: RecordTab; onClose?: () => void; page?: boolean; save: "idle" | "saving" | "saved" | "error"; onPreload: () => void }) {
  const c = ctx.detail.company;
  const router = useRouter();
  const timer = useTimer();
  const timing = timer.running?.company_id === c.id;

  async function toggleArchive() {
    const value = !c.archived_at;
    const ok = await ctx.mutate({ archived_at: value ? new Date().toISOString() : null }, async () => {
      const r = await attempt(() => setArchivedAction([c.id], value));
      return r.ok ? { ok: true } : r;
    });
    if (ok) toast.success(value ? "Fiche archivée" : "Fiche restaurée");
  }

  const iconBtn = "rounded-md p-1.5 text-muted hover:bg-surface";
  return (
    // sur mobile, en pleine page, la barre de l'application occupe le haut de l'écran : l'en-tête se cale dessous
    <header className={cn("sticky z-10 border-b border-line bg-white", page ? "top-[53px] md:top-0" : "top-0 px-4 pt-3 md:px-6")}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate font-display text-xl font-extrabold" title={c.name}>{c.name}</h2>
          {c.website && (
            <a
              href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`}
              target="_blank"
              rel="noreferrer noopener"
              title={c.website}
              aria-label={`Site web de ${c.name}`}
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-violet-strong hover:underline"
            >
              <span className="hidden max-w-44 truncate sm:inline">{c.domain_norm ?? c.website}</span> <ExternalLink size={12} />
            </a>
          )}
          {c.archived_at && <Badge tone="warning">Archivée</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {save !== "idle" && <SaveIndicator state={save} />}
          {!page && (
            <Link href={`/fiches/${c.id}`} className={cn(iconBtn, "hidden md:block")} aria-label="Ouvrir en pleine page" title="Pleine page">
              <Maximize2 size={16} />
            </Link>
          )}
          {onClose && (
            <button onClick={onClose} className={iconBtn} aria-label="Fermer">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <StageControl ctx={ctx} />
        <ContactControl ctx={ctx} />
        {c.do_not_contact && (
          <button type="button" onClick={() => ctx.go("details", { section: "prospecting" })} title={c.do_not_contact_reason ?? undefined}>
            <Badge tone="danger" className="h-8 px-2.5 text-xs"><Ban size={12} /> Ne plus contacter</Badge>
          </button>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
        <nav role="tablist" aria-label="Sections de la fiche" className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => ctx.go(t.key)}
              onPointerEnter={onPreload}
              onFocus={onPreload}
              className={cn("-mb-px border-b-2 px-2 py-2 font-label text-sm font-semibold whitespace-nowrap sm:px-3", tab === t.key ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 pb-1 max-sm:pt-1">
          <QuickAction icon={Mail} label="Envoyer un mail" onClick={() => ctx.compose({})} warn={c.do_not_contact} />
          <QuickAction icon={CheckSquare} label="Créer une tâche" onClick={ctx.newTask} />
          <DraftsAccess ctx={ctx} />
          <TrashButton kind="company" id={c.id} size="sm" variant="secondary" className="max-md:h-8 max-md:w-9 max-md:px-0"
            sync={[["companies"], ["company", c.id], ["pipeline-cards"], ["company-timeline"]]}
            onDone={() => { if (page) router.push("/prospection/base"); else onClose?.(); }} />
          <Popover label="Actions" align="right"
            triggerClass="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-surface"
            trigger={<><MoreHorizontal size={14} /> <span className="max-md:hidden">Actions</span><ChevronDown size={12} className="text-muted max-md:hidden" /></>}>
            {(close) => (
              <div data-actions-menu>
                <MenuItem icon={StickyNote} onClick={() => { close(); ctx.logExchange("note"); }}>Ajouter une note</MenuItem>
                <MenuItem icon={Phone} onClick={() => { close(); ctx.logExchange("call"); }}>Enregistrer un appel</MenuItem>
                <MenuItem icon={MessageSquarePlus} onClick={() => { close(); ctx.logExchange("message_in"); }}>Enregistrer un autre échange</MenuItem>
                <MenuItem icon={Timer} onClick={() => { close(); if (timing) timer.stop(); else timer.openStart({ id: c.id, name: c.name }); }}>{timing ? "Arrêter le chrono" : "Démarrer un chrono"}</MenuItem>
                <MenuItem icon={Sparkles} onClick={() => { close(); ctx.generateDiagnostic(); }}>Générer un diagnostic</MenuItem>
                <MenuItem icon={FileUp} onClick={() => { close(); ctx.go("details", { section: "files" }); }}>Ajouter un fichier</MenuItem>
                <MenuItem icon={Pencil} onClick={() => { close(); ctx.go("details", { section: "company", edit: true }); }}>Modifier les informations</MenuItem>
                <div className="my-1 border-t border-line" />
                <MenuItem icon={c.archived_at ? ArchiveRestore : Archive} onClick={() => { close(); toggleArchive(); }}>{c.archived_at ? "Restaurer la fiche" : "Archiver la fiche"}</MenuItem>
              </div>
            )}
          </Popover>
        </div>
      </div>
    </header>
  );
}

function QuickAction({ icon: Icon, label, onClick, warn }: { icon: typeof Mail; label: string; onClick: () => void; warn?: boolean }) {
  return (
    <Button size="sm" onClick={onClick} aria-label={label} title={warn ? `${label} (fiche marquée « Ne plus contacter »)` : label} className={cn("max-md:h-8 max-md:w-9 max-md:px-0", warn && "border-danger/30 text-danger")}>
      {warn ? <Ban size={13} /> : <Icon size={13} />}
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

/** Brouillons de la fiche : accès compact (objet, destinataire, dernière modification). */
function DraftsAccess({ ctx }: { ctx: RecordCtx }) {
  const mails = useCompanyMails(ctx.detail.company.id);
  const drafts = (mails.data ?? []).filter((m) => m.status === "draft").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!drafts.length) return null;
  return (
    <Popover label={`Brouillons (${drafts.length})`} align="right" triggerClass="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-surface"
      trigger={<><Pencil size={12} /> {drafts.length} <span className="max-md:hidden">brouillon{drafts.length > 1 ? "s" : ""}</span></>}>
      {(close) => (
        <ul className="max-h-72 overflow-y-auto" data-drafts>
          {drafts.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => { close(); ctx.compose({ message: m }); }} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-surface">
                <span className="block truncate text-sm font-semibold">{m.subject || "(sans objet)"}</span>
                <span className="block truncate text-xs text-muted">{m.to_addrs.join(", ") || "Sans destinataire"} · {formatDateTime(m.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
