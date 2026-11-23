"use client";

// Onboarding de l'offre découverte, côté client : plein écran, une question par écran, Entrée pour valider,
// barre de progression, sauvegarde à chaque réponse (et brouillon local tant que le réseau manque), reprise exacte.
// Deux contacts en même temps : une réponse modifiée entre-temps n'est jamais écrasée sans le montrer.
// Chaque écran a une seule action principale (bouton plein) ; le reste est en lien discret.
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock, Copy, CornerDownLeft, ExternalLink, ImageIcon, MessageSquare, Plus, X } from "lucide-react";
import {
  AFTER_SEND, BLACKLIST_HELP, DOCUMENTS_HELP, LEMLIST_INVITE_DEFAULT, LEMLIST_TUTO, LEMLIST_URL, LINKEDIN_EXPORT_URL, LINKEDIN_TUTO, MASCOT_LINES, OFFER, OFFER_QUESTIONS,
  OWNER_FIRST_NAME, STEPS, TARGET_FIELDS, TIMELINE, UNKNOWN, WEBSITE_FIELD, type StepKey, type TutoStep,
} from "@/lib/discovery/content";
import { stepComplete, targetHandled, type DiscoveryTarget, type DiscoveryView, type StepStatus, type TargetField } from "@/lib/discovery/types";
import { WEBSITE_ERROR, WEBSITE_KEY, WEBSITE_MAX, normalizeWebsite } from "@/lib/discovery/website";
import type { FlowApi } from "./flow-api";
import { Guide, type Mood } from "./mascot";
import { UploadBox } from "./upload-box";
import "./onboarding.css";

type Screen = { id: string; step: StepKey | "sent"; sub?: number };
const SCREENS: Screen[] = [
  { id: "welcome", step: "welcome" },
  ...OFFER_QUESTIONS.map((_, i) => ({ id: `offer:${i}`, step: "offer" as const, sub: i })),
  { id: "lemlist", step: "lemlist" },
  { id: "blacklist", step: "blacklist" },
  { id: "linkedin", step: "linkedin" },
  { id: "documents", step: "documents" },
  ...[0, 1, 2].map((i) => ({ id: `targets:${i}`, step: "targets" as const, sub: i })),
  { id: "recap", step: "recap" },
  { id: "sent", step: "sent" },
];
const LAST = SCREENS.length - 2; // « recap » : 100 %
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
const DRAFT = "cely-discovery-draft:";
/** Brouillon de la case « Je ne sais pas » d'une question (à côté du brouillon de sa réponse). */
const unknownKey = (key: string) => `${key}:unknown`;
const isTouch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

function readDraft(project: string, key: string): string | null {
  try { return window.localStorage.getItem(`${DRAFT}${project}:${key}`); } catch { return null; }
}
function writeDraft(project: string, key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(`${DRAFT}${project}:${key}`);
    else window.localStorage.setItem(`${DRAFT}${project}:${key}`, value);
  } catch { /* navigation privée : la sauvegarde serveur reste la référence */ }
}

function firstScreen(v: DiscoveryView): number {
  if (v.position) {
    const i = SCREENS.findIndex((x) => x.id === v.position);
    if (i >= 0) return i;
  }
  if (v.sent_at) return SCREENS.length - 1;
  if (!v.started_at) return 0;
  const i = SCREENS.findIndex((x) => x.step !== "welcome" && x.step !== "sent" && x.step !== "recap" &&
    (x.step === "offer" ? !v.answers[OFFER_QUESTIONS[x.sub!].key] : x.step === "targets" ? !targetHandled(v.targets[x.sub!]) : !stepComplete(v, x.step)));
  return i >= 0 ? i : LAST;
}

function introLine(sc: Screen, firstName: string): string | null {
  if (sc.id === "welcome") return MASCOT_LINES.welcome.replace("{prénom}", firstName || "toi");
  if (sc.id === "recap") return MASCOT_LINES.recap;
  if (sc.step === "linkedin") return "Celle-ci peut attendre : LinkedIn met parfois jusqu'à 24 h à envoyer l'archive.";
  if (sc.step === "targets" && sc.sub === 0) return "Voici les cibles que j'ai préparées pour toi. Valide-les ou dis-moi ce qui cloche.";
  if (sc.step === "lemlist") return "Petit détour par lemlist : 3 minutes, promis.";
  return null;
}

type Conflict = { key: string; mine: string; mineUnknown: boolean; theirs: string; theirsUnknown: boolean; by: string | null; rev: number };
type SaveState = "idle" | "saving" | "saved" | "offline";
type Pending = { value: string; unknown: boolean };
type OfferSubmit = { value: string; unknown: boolean; website: string | null };

export function DiscoveryFlow({ initial, api, exitHref }: { initial: DiscoveryView; api: FlowApi; exitHref: string }) {
  const project = initial.project.id;
  const [view, setView] = useState(initial);
  const [idx, setIdx] = useState(() => firstScreen(initial));
  const [mood, setMood] = useState<Mood>("wave");
  const [say, setSay] = useState(() => introLine(SCREENS[firstScreen(initial)], initial.me?.first_name ?? "") ?? "");
  const [burst, setBurst] = useState(0);
  const [save, setSave] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [uploading, setUploading] = useState(false);
  const pending = useRef(new Map<string, Pending>());
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const readOnly = view.project.read_only;
  const screen = SCREENS[idx];
  const firstName = view.me?.first_name ?? "";

  const reload = useCallback(async () => {
    const r = await api.reload();
    if (r.ok) setView(r.data);
    return r.ok ? r.data : null;
  }, [api]);

  // --- humeur de la mascotte ---
  const moodTimer = useRef<number | undefined>(undefined);
  const react = useCallback((m: Mood, line: string, confetti = false) => {
    setMood(m);
    setSay(line);
    if (confetti) setBurst((b) => b + 1);
    window.clearTimeout(moodTimer.current);
    moodTimer.current = window.setTimeout(() => setMood("idle"), m === "cheer" ? 1500 : 900);
  }, []);

  // --- reprise exacte : l'écran courant est enregistré à chaque changement ---
  useEffect(() => {
    if (readOnly) return;
    const t = window.setTimeout(() => { void api.position(screen.id); }, 300);
    return () => window.clearTimeout(t);
  }, [api, screen.id, readOnly]);

  // --- réponses : sauvegarde, conflit, brouillon hors ligne ---
  // `unknown` = « Je ne sais pas » : la valeur enregistrée est vide. Une réponse saisie l'emporte toujours.
  const saveAnswer = useCallback(async (key: string, raw: string, opts: { unknown?: boolean; force?: number } = {}): Promise<boolean> => {
    const value = raw.trim();
    const unknown = !!opts.unknown && !value;
    const cur = viewRef.current.answers[key];
    const clearDraft = () => { writeDraft(project, key, null); writeDraft(project, unknownKey(key), null); };
    if ((cur?.value ?? "") === value && !!cur?.unknown === unknown && opts.force === undefined) { clearDraft(); return true; }
    writeDraft(project, key, value);
    writeDraft(project, unknownKey(key), unknown ? "1" : "0");
    setSave("saving");
    const r = await api.answer(key, value, opts.force ?? cur?.rev ?? 0, unknown);
    if (!r.ok) {
      if (r.network) { pending.current.set(key, { value, unknown }); setSave("offline"); return true; } // brouillon gardé, renvoyé au retour du réseau
      setSave("idle");
      react("think", r.error);
      return false;
    }
    if (!r.data.ok) {
      setSave("idle");
      setConflict({ key, mine: value, mineUnknown: unknown, theirs: r.data.value, theirsUnknown: !!r.data.unknown, by: r.data.by, rev: r.data.rev });
      react("think", MASCOT_LINES.conflict);
      return false;
    }
    const rev = r.data.rev;
    pending.current.delete(key);
    clearDraft();
    setView((v) => {
      const nv = { ...v, answers: { ...v.answers, [key]: { value, unknown, rev, by: v.me?.first_name ?? null, mine: true, at: new Date().toISOString() } } };
      viewRef.current = nv;
      return nv;
    });
    setSave("saved");
    return true;
  }, [api, project, react]);

  // brouillons restés dans le navigateur (coupure, fermeture) : renvoyés au chargement et au retour du réseau
  useEffect(() => {
    if (readOnly || api.preview) return;
    for (const q of OFFER_QUESTIONS) {
      const saved = initial.answers[q.key];
      const d = readDraft(project, q.key);
      const u = readDraft(project, unknownKey(q.key));
      const value = d ?? saved?.value ?? "";
      const unknown = (u === null ? !!saved?.unknown : u === "1") && !value.trim();
      if (value.trim() !== (saved?.value ?? "") || unknown !== !!saved?.unknown) pending.current.set(q.key, { value, unknown });
    }
    // lien du site : un brouillon invalide reste dans le champ, il n'est jamais envoyé tel quel
    const site = readDraft(project, WEBSITE_KEY);
    const cleanSite = site === null ? null : normalizeWebsite(site);
    if (cleanSite !== null && cleanSite !== (initial.answers[WEBSITE_KEY]?.value ?? "")) pending.current.set(WEBSITE_KEY, { value: cleanSite, unknown: false });
    const flush = () => { for (const [k, p] of pending.current) void saveAnswer(k, p.value, { unknown: p.unknown }); };
    flush();
    window.addEventListener("online", flush);
    const t = window.setInterval(() => { if (pending.current.size) flush(); }, 15000);
    return () => { window.removeEventListener("online", flush); window.clearInterval(t); };
  }, [api.preview, initial.answers, project, readOnly, saveAnswer]);

  // --- étapes ---
  const markStep = useCallback(async (step: StepKey, status: StepStatus | null, line?: string) => {
    const prev = viewRef.current.steps[step];
    const apply = (v: DiscoveryView, st: StepStatus | null): DiscoveryView => {
      const steps = { ...v.steps };
      if (st) steps[step] = { status: st, by: v.me?.first_name ?? null, at: new Date().toISOString() };
      else delete steps[step];
      return { ...v, steps };
    };
    // mise à jour fonctionnelle : ne jamais repartir d'une copie périmée (une cible validée juste avant, etc.)
    setView((v) => { const n = apply(v, status); viewRef.current = n; return n; });
    const r = await api.step(step, status);
    if (!r.ok) {
      react("think", r.network ? MASCOT_LINES.offline : r.error);
      if (!r.network) setView((v) => (prev ? { ...v, steps: { ...v.steps, [step]: prev } } : apply(v, null)));
      return false;
    }
    const newlyDone = status === "done" && prev?.status !== "done" && step !== "welcome";
    if (newlyDone) react("happy", line ?? pick(MASCOT_LINES.stepDone));
    else if (line) react("happy", line);
    return true;
  }, [api, react]);

  const go = useCallback((to: number) => {
    const i = Math.max(0, Math.min(SCREENS.length - 1, to));
    setConflict(null);
    setIdx(i);
    const line = introLine(SCREENS[i], viewRef.current.me?.first_name ?? "");
    if (line) setSay(line);
    window.scrollTo({ top: 0 });
  }, []);
  const next = useCallback(() => go(idx + 1), [go, idx]);
  const jump = (id: string) => go(SCREENS.findIndex((x) => x.id === id));

  // --- Entrée sur un écran sans champ : action principale ---
  const primary = useRef<(() => void) | null>(null);
  const setPrimary = useCallback((fn: (() => void) | null) => { primary.current = fn; }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.repeat) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, button, a, select, [contenteditable]")) return;
      if (primary.current) { e.preventDefault(); primary.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // le focus entre dans le parcours (il restait sinon sur le lien du portail, sous la page plein écran)
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [screen.id]);

  const progress = Math.round((Math.min(idx, LAST) / LAST) * 100);
  const currentStep = STEPS.findIndex((x) => x.key === screen.step);
  const offerQuestion = screen.step === "offer" ? OFFER_QUESTIONS[screen.sub!] : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white text-ink" data-discovery-flow data-screen={screen.id}>
      <header className="sticky top-0 z-10 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-3 px-5">
          <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={62} height={22} priority />
          <span className="ml-auto text-xs text-muted" aria-live="polite" data-save={save}>
            {api.preview ? <strong className="text-warning">Aperçu : rien n&apos;est enregistré</strong>
              : save === "saving" ? "Enregistrement…" : save === "saved" ? <span className="inline-flex items-center gap-1 text-success"><Check size={12} aria-hidden /> Enregistré</span>
              : save === "offline" ? <span className="text-warning">Hors ligne : gardé sur cet appareil</span> : null}
          </span>
          <Link href={exitHref} className="-mr-2 rounded-lg p-2 text-muted hover:bg-surface hover:text-ink" aria-label="Quitter l'onboarding (tout est enregistré)" title="Quitter (tout est enregistré)"><X size={18} /></Link>
        </div>
        <div className="h-1 bg-surface" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progression de l'onboarding">
          <div className="cob-progress h-full bg-violet-strong" style={{ width: `${progress}%` }} />
        </div>
      </header>

      <main ref={mainRef} tabIndex={-1} className="mx-auto max-w-2xl px-5 pt-8 pb-32 outline-none sm:pt-12">
        {readOnly && <p className="mb-6 rounded-lg bg-amber-50 px-3 py-2 text-sm text-warning">Ce projet est archivé : l&apos;onboarding est consultable mais plus modifiable.</p>}
        <div className="mb-8">
          <Guide mood={mood} say={say} burst={burst} size={screen.id === "welcome" || screen.id === "sent" ? 72 : 56} />
        </div>
        <div key={screen.id} className="cob-screenIn">
          {screen.id === "welcome" && <Welcome onStart={() => { void markStep("welcome", "done"); react("happy", "C'est parti !"); next(); }} setPrimary={setPrimary} firstName={firstName} />}
          {offerQuestion && (
            <OfferQuestion
              key={screen.id} index={screen.sub!} view={view} project={project} readOnly={readOnly}
              conflict={conflict && (conflict.key === offerQuestion.key || (conflict.key === WEBSITE_KEY && offerQuestion.key === WEBSITE_FIELD.question)) ? conflict : null}
              onSubmit={async ({ value, unknown, website }) => {
                // le lien du site d'abord : s'il est refusé, on reste sur la question
                if (website !== null && !(await saveAnswer(WEBSITE_KEY, website))) return;
                if (!(await saveAnswer(offerQuestion.key, value, { unknown }))) return;
                const last = screen.sub === OFFER_QUESTIONS.length - 1;
                if (last) await markStep("offer", "done", "Merci ! Avec ça, je peux écrire des messages qui te ressemblent.");
                else if (unknown) react("happy", MASCOT_LINES.unknown);
                else if (value.trim()) react("happy", pick(MASCOT_LINES.offerAnswered));
                next();
              }}
              onResolve={async (keepMine) => {
                if (!conflict) return;
                if (keepMine) { if (await saveAnswer(conflict.key, conflict.mine, { unknown: conflict.mineUnknown, force: conflict.rev })) setConflict(null); }
                else {
                  setView((v) => ({ ...v, answers: { ...v.answers, [conflict.key]: { value: conflict.theirs, unknown: conflict.theirsUnknown, rev: conflict.rev, by: conflict.by, mine: false, at: new Date().toISOString() } } }));
                  writeDraft(project, conflict.key, null);
                  writeDraft(project, unknownKey(conflict.key), null);
                  setConflict(null);
                }
              }}
            />
          )}
          {screen.id === "lemlist" && <Lemlist view={view} readOnly={readOnly} setPrimary={setPrimary} onDone={async () => { if (await markStep("lemlist", "done", "Top, je surveille l'invitation !")) next(); }} />}
          {screen.id === "blacklist" && (
            <FilesStep step="blacklist" view={view} api={api} readOnly={readOnly} onActive={setUploading} uploading={uploading}
              onChanged={async (added) => { const v = await reload(); if (added && v && v.steps.blacklist?.status === "none") await markStep("blacklist", null); }}
              onContinue={async () => { await markStep("blacklist", "done"); next(); }}
              onNone={async () => { await markStep("blacklist", "none", MASCOT_LINES.none); next(); }} noneLabel="Je n'en ai pas" />
          )}
          {screen.id === "linkedin" && (
            <LinkedIn view={view} api={api} readOnly={readOnly} onActive={setUploading} uploading={uploading}
              onChanged={() => { void reload(); }}
              onContinue={async () => { await markStep("linkedin", "done", "Archive reçue, merci !"); next(); }}
              onLater={async () => { await markStep("linkedin", "later", MASCOT_LINES.later); next(); }} />
          )}
          {screen.id === "documents" && (
            <FilesStep step="documents" view={view} api={api} readOnly={readOnly} onActive={setUploading} uploading={uploading}
              onChanged={() => { void reload(); }}
              onContinue={async () => { await markStep("documents", "done"); next(); }}
              onNone={async () => { await markStep("documents", "none", MASCOT_LINES.none); next(); }} noneLabel="Rien à ajouter" />
          )}
          {screen.step === "targets" && (
            <Target key={screen.id} index={screen.sub!} view={view} api={api} readOnly={readOnly}
              setView={setView} reload={reload} react={react}
              onHandled={async (v) => { if (v.targets.every(targetHandled) && viewRef.current.steps.targets?.status !== "done") await markStep("targets", "done", "Les 3 cibles sont calées !"); }}
              onNext={next} setPrimary={setPrimary} />
          )}
          {screen.id === "recap" && <Recap view={view} api={api} readOnly={readOnly} jump={jump} uploading={uploading}
            onSent={(already) => { void reload(); react("cheer", already ? "C'était déjà envoyé : tout est bien arrivé !" : MASCOT_LINES.sent, true); go(SCREENS.length - 1); }} />}
          {screen.id === "sent" && <Sent view={view} onReview={() => jump("recap")} exitHref={exitHref} />}
        </div>
      </main>

      {idx > 0 && screen.id !== "sent" && (
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-white" aria-label="Navigation de l'onboarding">
          <div className="mx-auto flex max-w-2xl items-center gap-2 px-3 py-2">
            <button type="button" onClick={() => go(idx - 1)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface hover:text-ink">
              <ArrowLeft size={16} aria-hidden /> Retour
            </button>
            <span className="mx-auto text-xs text-muted">
              {screen.step === "recap" ? "Dernière étape" : <>Étape {currentStep} sur {STEPS.length - 1}<span className="hidden sm:inline"> · {STEPS[currentStep]?.short}</span></>}
            </span>
            {screen.id !== "recap" && (
              <button type="button" onClick={next} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface hover:text-ink" data-skip>
                Plus tard <ArrowRight size={16} aria-hidden />
              </button>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Éléments communs : un titre, un sur-titre, une action principale par écran, des liens discrets pour le reste.
type Data = Record<`data-${string}`, string | boolean>;
type Click = () => void | Promise<void>;

/** Un clic à la fois : tant que l'action n'est pas terminée, les clics suivants (double clic) sont ignorés. */
function useOnce(onClick: Click) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try { await onClick(); } finally { lock.current = false; setBusy(false); }
  };
  return { run, busy };
}

function Big({ children }: { children: React.ReactNode }) {
  return <h1 className="font-display text-[1.75rem] leading-tight font-extrabold tracking-tight text-ink sm:text-[2rem]">{children}</h1>;
}
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-label text-xs font-semibold tracking-wide text-violet-strong uppercase">{children}</p>;
}
/** L'action principale de l'écran (une seule par écran). */
function Primary({ children, onClick, disabled, ...rest }: { children: React.ReactNode; onClick: Click; disabled?: boolean } & Data) {
  const { run, busy } = useOnce(onClick);
  return (
    <button type="button" onClick={() => void run()} disabled={disabled || busy} {...rest}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-ink px-6 text-base font-semibold text-white hover:bg-violet-strong disabled:opacity-40 sm:w-auto">
      {children}
    </button>
  );
}
/** Action secondaire : un lien discret, jamais un second bouton plein. */
function Quiet({ children, onClick, disabled, ...rest }: { children: React.ReactNode; onClick: Click; disabled?: boolean } & Data) {
  const { run, busy } = useOnce(onClick);
  return (
    <button type="button" onClick={() => void run()} disabled={disabled || busy} {...rest}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-40">
      {children}
    </button>
  );
}
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1 pt-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">{children}</div>;
}
const EnterHint = () => <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">ou <kbd className="inline-flex items-center gap-0.5 rounded border border-line bg-white px-1.5 py-0.5 font-sans font-semibold">Entrée <CornerDownLeft size={11} aria-hidden /></kbd></span>;
const FIELD = "w-full rounded-lg border border-line bg-white px-4 py-3 text-base text-ink outline-none placeholder:text-muted/60 focus:border-violet focus:ring-2 focus:ring-violet/20 disabled:bg-surface";

type SetPrimary = (fn: (() => void) | null) => void;
/** Action déclenchée par Entrée quand aucun champ n'a le focus (écrans sans saisie). */
function usePrimary(setPrimary: SetPrimary, fn: (() => void) | null) {
  useEffect(() => {
    setPrimary(fn);
    return () => setPrimary(null);
  });
}

function Welcome({ onStart, setPrimary, firstName }: { onStart: () => void; setPrimary: SetPrimary; firstName: string }) {
  usePrimary(setPrimary, onStart);
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Big>{firstName ? `${firstName}, ` : ""}bienvenue dans ton test de {OFFER.days} jours</Big>
        <p className="text-lg text-muted">{OFFER.contacts} contacts, {OFFER.targets} cibles, {OFFER.channels}. Ici, tu me donnes tout ce qu&apos;il faut pour lancer : environ <strong className="text-ink">{OFFER.estimatedMinutes} minutes</strong>, et tu peux t&apos;arrêter quand tu veux, tout est enregistré.</p>
      </div>
      <ol className="divide-y divide-line border-y border-line">
        {TIMELINE.map((t) => (
          <li key={t.when} className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4">
            <span className="font-label text-xs font-semibold tracking-wide text-violet-strong uppercase sm:pt-0.5">{t.when}</span>
            <span className="text-sm">{t.what}</span>
          </li>
        ))}
      </ol>
      <div>
        <p className="text-sm font-semibold">À avoir sous la main</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          {MASCOT_LINES.welcomeKit.map((k) => <li key={k} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-success" aria-hidden /> {k}</li>)}
        </ul>
      </div>
      <Actions>
        <Primary onClick={onStart} data-start>C&apos;est parti <ArrowRight size={18} aria-hidden /></Primary>
        <EnterHint />
      </Actions>
    </section>
  );
}

function OfferQuestion({ index, view, project, readOnly, conflict, onSubmit, onResolve }: {
  index: number; view: DiscoveryView; project: string; readOnly: boolean; conflict: Conflict | null;
  onSubmit: (a: OfferSubmit) => Promise<void>; onResolve: (keepMine: boolean) => Promise<void>;
}) {
  const q = OFFER_QUESTIONS[index];
  const saved = view.answers[q.key];
  const [value, setValue] = useState(() => readDraft(project, q.key) ?? saved?.value ?? "");
  const [unknown, setUnknown] = useState(() => {
    const d = readDraft(project, unknownKey(q.key));
    return d === null ? !!saved?.unknown : d === "1";
  });
  // réponse mise de côté quand la case est cochée : elle revient si on la décoche
  const stash = useRef("");
  const [needed, setNeeded] = useState(false);
  const [example, setExample] = useState(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { if (!isTouch()) ref.current?.focus(); }, []);
  // version adoptée après un conflit : le champ suit la réponse retenue
  const [seenRev, setSeenRev] = useState(saved?.rev ?? 0);
  if (saved && saved.rev !== seenRev && !saved.mine) { setSeenRev(saved.rev); setValue(saved.value); setUnknown(!!saved.unknown); }

  // lien du site (question 4 uniquement) : facultatif, format vérifié avant d'avancer
  const hasSite = q.key === WEBSITE_FIELD.question;
  const savedSite = view.answers[WEBSITE_KEY];
  const [site, setSite] = useState(() => (hasSite ? readDraft(project, WEBSITE_KEY) ?? savedSite?.value ?? "" : ""));
  const [siteError, setSiteError] = useState(false);
  const [seenSiteRev, setSeenSiteRev] = useState(savedSite?.rev ?? 0);
  if (hasSite && savedSite && savedSite.rev !== seenSiteRev && !savedSite.mine) { setSeenSiteRev(savedSite.rev); setSite(savedSite.value); }

  // brouillon local à chaque frappe : une coupure ou une fermeture d'onglet ne perd rien
  const onChange = (v: string) => {
    setValue(v);
    setNeeded(false);
    writeDraft(project, q.key, v);
    // une réponse saisie décoche « Je ne sais pas »
    if (unknown && v.trim()) { setUnknown(false); writeDraft(project, unknownKey(q.key), "0"); }
  };
  const onUnknown = (checked: boolean) => {
    setUnknown(checked);
    setNeeded(false);
    const text = checked ? "" : stash.current;
    if (checked) stash.current = value;
    setValue(text);
    writeDraft(project, q.key, text);
    writeDraft(project, unknownKey(q.key), checked ? "1" : "0");
  };
  const onSite = (v: string) => { setSite(v); setSiteError(false); writeDraft(project, WEBSITE_KEY, v); };
  const tidySite = () => {
    const clean = normalizeWebsite(site);
    if (clean === null) setSiteError(true);
    else if (clean !== site) onSite(clean); // « exemple.fr » → « https://exemple.fr »
    return clean;
  };

  const { run: submit, busy } = useOnce(async () => {
    if (readOnly) return;
    const clean = hasSite ? tidySite() : null;
    if (hasSite && clean === null) { document.getElementById("q-website")?.focus(); return; }
    if (!value.trim() && !unknown && !q.optional) { setNeeded(true); ref.current?.focus(); return; }
    await onSubmit({ value, unknown: unknown && !value.trim(), website: clean });
  });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing && !(q.multiline && isTouch())) { e.preventDefault(); void submit(); }
  };
  const theirs = conflict ? (conflict.theirsUnknown ? `« ${UNKNOWN.label} »` : conflict.theirs || "(vide)") : "";
  return (
    <section className="space-y-6" data-question={q.key}>
      <div className="space-y-3">
        <Eyebrow>Question {index + 1} sur {OFFER_QUESTIONS.length}{q.optional ? " · facultative" : ""}</Eyebrow>
        <Big><label htmlFor={`q-${q.key}`}>{q.title}</label></Big>
        <p className="text-base text-muted">{q.help}</p>
      </div>
      <div className="space-y-3">
        {q.multiline ? (
          <textarea id={`q-${q.key}`} ref={ref} value={value} rows={4} maxLength={5000} disabled={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
            placeholder={unknown ? "" : q.placeholder} aria-describedby={needed ? `need-${q.key}` : undefined} className={`${FIELD} min-h-32 resize-y`} data-answer />
        ) : (
          <input id={`q-${q.key}`} type="text" ref={ref} value={value} maxLength={5000} disabled={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
            placeholder={unknown ? "" : q.placeholder} aria-describedby={needed ? `need-${q.key}` : undefined} className={FIELD} enterKeyHint="next" data-answer />
        )}
        {q.example && (
          <p className="text-sm text-muted">
            <button type="button" onClick={() => setExample(!example)} className="font-semibold text-violet-strong hover:underline" aria-expanded={example}>{example ? "Masquer l'exemple" : "Voir un exemple"}</button>
            {example && <span className="mt-1 block italic">{q.example}</span>}
          </p>
        )}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
          <input type="checkbox" checked={unknown} disabled={readOnly} onChange={(e) => onUnknown(e.target.checked)} className="size-5 shrink-0 accent-violet-strong" data-unknown />
          <span><span className="font-semibold">{UNKNOWN.label}</span>{unknown && <span className="text-muted"> · {UNKNOWN.hint}</span>}</span>
        </label>
        {needed && <p id={`need-${q.key}`} role="alert" className="text-sm text-danger" data-needed>{UNKNOWN.needed}</p>}
        {saved && !saved.mine && saved.by && !conflict && <p className="text-xs text-muted">Réponse de {saved.by}</p>}
      </div>
      {hasSite && (
        <div className="space-y-2 border-t border-line pt-6">
          <label htmlFor="q-website" className="block text-sm font-semibold">{WEBSITE_FIELD.label}</label>
          <input id="q-website" type="url" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} value={site} maxLength={WEBSITE_MAX} disabled={readOnly}
            onChange={(e) => onSite(e.target.value)} onBlur={() => { if (site.trim()) tidySite(); }} onKeyDown={onKey} placeholder={WEBSITE_FIELD.placeholder}
            aria-invalid={siteError} aria-describedby={siteError ? "q-website-error" : undefined} className={`${FIELD} ${siteError ? "border-danger focus:border-danger focus:ring-danger/20" : ""}`} enterKeyHint="next" data-website />
          {siteError && <p id="q-website-error" role="alert" className="text-sm text-danger" data-website-error>{WEBSITE_ERROR}</p>}
        </div>
      )}
      {conflict ? (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4" role="alert" data-conflict>
          <p className="font-semibold text-warning">{conflict.by ?? "Quelqu'un de ton équipe"} a modifié {conflict.key === WEBSITE_KEY ? "le lien du site" : "cette réponse"} pendant que tu écrivais :</p>
          <blockquote className="rounded-lg bg-white px-3 py-2 text-sm whitespace-pre-wrap">{theirs}</blockquote>
          <Actions>
            <Primary onClick={() => onResolve(true)} data-keep-mine>Garder la mienne</Primary>
            <Quiet onClick={() => onResolve(false)} data-keep-theirs>Garder sa version</Quiet>
          </Actions>
        </div>
      ) : (
        <Actions>
          <button type="button" onClick={() => void submit()} disabled={busy || readOnly} data-ok
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-ink px-6 text-base font-semibold text-white hover:bg-violet-strong disabled:opacity-40 sm:w-auto">
            {value.trim() || unknown || !q.optional ? "Continuer" : "Passer"} <ArrowRight size={18} aria-hidden />
          </button>
          <EnterHint />
          {q.multiline && <span className="hidden text-xs text-muted sm:inline">· Maj + Entrée pour aller à la ligne</span>}
        </Actions>
      )}
    </section>
  );
}

/** Étapes d'un tuto. `slots` : chaque étape a un visuel, ou un emplacement propre avec la légende de la capture à faire. */
function Tuto({ steps, alt, slots = false }: { steps: TutoStep[]; alt: string; slots?: boolean }) {
  return (
    <ol className="space-y-8">
      {steps.map((t, i) => (
        <li key={t.title} className="flex gap-4" data-tuto-step={i + 1}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-violet-soft font-label text-sm font-semibold text-violet-strong" aria-hidden>{i + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold"><span className="sr-only">Étape {i + 1} : </span>{t.title}</p>
            <p className="mt-1 text-sm text-muted">{t.body}</p>
            {t.image ? (
              <a href={t.image} target="_blank" rel="noopener noreferrer" className="mt-3 block" title="Agrandir la capture">
                <Image src={t.image} alt={`${alt}, étape ${i + 1} : ${t.capture}`} width={788} height={452} sizes="(min-width: 672px) 580px, 85vw" className="h-auto w-full rounded-lg border border-line" data-screenshot />
              </a>
            ) : slots ? (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-line bg-surface px-3 py-3 text-xs text-muted" data-screenshot-slot>
                <ImageIcon size={14} className="mt-0.5 shrink-0" aria-hidden /> <span>Capture à venir : {t.capture}</span>
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Lemlist({ view, readOnly, setPrimary, onDone }: { view: DiscoveryView; readOnly: boolean; setPrimary: SetPrimary; onDone: () => Promise<void> }) {
  const email = view.settings.lemlist_invite_email || LEMLIST_INVITE_DEFAULT;
  const done = view.steps.lemlist?.status === "done";
  const [copied, setCopied] = useState(false);
  const { run } = useOnce(onDone);
  usePrimary(setPrimary, readOnly ? null : () => void run());
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Eyebrow>Étape 2 · environ 3 minutes</Eyebrow>
        <Big>On crée ton espace lemlist</Big>
        <p className="text-base text-muted">C&apos;est l&apos;outil qui enverra tes emails et tes messages LinkedIn, depuis ton compte. Tu restes propriétaire de tout ; moi, j&apos;y prépare et pilote les campagnes.</p>
        <a href={LEMLIST_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-violet-strong hover:underline">Ouvrir lemlist <ExternalLink size={13} aria-hidden /></a>
      </div>
      <Tuto steps={LEMLIST_TUTO} alt="lemlist" slots />
      <div className="rounded-lg border border-line p-4">
        <p className="text-sm font-semibold">L&apos;adresse à inviter</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-surface px-3 py-2 text-base font-semibold break-all" data-invite-email>{email}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(email).then(() => setCopied(true), () => undefined)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-violet-strong hover:underline">
              {copied ? <><Check size={14} aria-hidden /> Copiée</> : <><Copy size={14} aria-hidden /> Copier</>}
            </button>
        </div>
      </div>
      <Actions>
        <Primary onClick={run} disabled={readOnly} data-lemlist-done>{done ? <><CheckCircle2 size={18} aria-hidden /> C&apos;est fait (confirmé)</> : <>C&apos;est fait <Check size={18} aria-hidden /></>}</Primary>
        <EnterHint />
      </Actions>
    </section>
  );
}

function FilesStep({ step, view, api, readOnly, onChanged, onContinue, onNone, noneLabel, onActive, uploading }: {
  step: "blacklist" | "documents"; view: DiscoveryView; api: FlowApi; readOnly: boolean; onChanged: (added: boolean) => void;
  onContinue: () => Promise<void>; onNone: () => Promise<void>; noneLabel: string; onActive: (a: boolean) => void; uploading: boolean;
}) {
  const files = view.files.filter((f) => f.step === step);
  const blacklist = step === "blacklist";
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Eyebrow>{blacklist ? "Étape 3 · 1 minute" : "Étape 5 · facultative"}</Eyebrow>
        <Big>{blacklist ? "Ta blacklist" : "D'autres documents utiles ?"}</Big>
        {blacklist ? (
          <>
            <p className="text-base text-muted">{BLACKLIST_HELP.why}</p>
            <p className="text-sm text-muted">{BLACKLIST_HELP.format}</p>
          </>
        ) : <p className="text-base text-muted">{DOCUMENTS_HELP}</p>}
      </div>
      <UploadBox api={api} projectId={view.project.id} step={step} files={files} multiple onChanged={onChanged} onActive={onActive} disabled={readOnly || api.preview} />
      {api.preview && <p className="text-xs text-warning">Aperçu : le dépôt est désactivé.</p>}
      <Actions>
        <Primary onClick={onContinue} disabled={readOnly || !files.length || uploading} data-continue>Continuer <ArrowRight size={18} aria-hidden /></Primary>
        <Quiet onClick={onNone} disabled={readOnly || uploading} data-none>{noneLabel}</Quiet>
      </Actions>
      {uploading && <p className="text-xs text-muted">Un envoi est en cours : attends qu&apos;il se termine avant de passer à la suite.</p>}
    </section>
  );
}

function LinkedIn({ view, api, readOnly, onChanged, onContinue, onLater, onActive, uploading }: {
  view: DiscoveryView; api: FlowApi; readOnly: boolean; onChanged: () => void; onContinue: () => Promise<void>; onLater: () => Promise<void>;
  onActive: (a: boolean) => void; uploading: boolean;
}) {
  const files = view.files.filter((f) => f.step === "linkedin");
  const [accounts, setAccounts] = useState<string[]>(() => [files.length ? "" : view.me?.first_name ?? ""]);
  const later = view.steps.linkedin?.status === "later";
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Eyebrow>Étape 4 · 2 minutes maintenant, le reste plus tard</Eyebrow>
        <Big>Tes archives LinkedIn</Big>
        <p className="text-base text-muted">Avec ton archive, je retrouve tes connexions et tes échanges : on évite de contacter des gens que tu connais déjà, et on s&apos;appuie sur ton réseau.</p>
        <p className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-warning" data-linkedin-warning>
          <Clock size={18} className="shrink-0" aria-hidden />
          <span><strong>LinkedIn peut mettre jusqu&apos;à 24 h à t&apos;envoyer l&apos;archive.</strong> Demande-la maintenant, choisis « Je l&apos;ajouterai plus tard », et reviens ici quand tu as reçu l&apos;email : l&apos;étape reste ouverte.</span>
        </p>
        <a href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-violet-strong hover:underline">Ouvrir la page LinkedIn « Télécharger vos données » <ExternalLink size={13} aria-hidden /></a>
      </div>
      <Tuto steps={LINKEDIN_TUTO} alt="LinkedIn" />
      <div className="space-y-6">
        {accounts.map((name, i) => (
          <div key={i} className="space-y-2" data-linkedin-account={i}>
            <label className="block text-sm font-semibold" htmlFor={`li-${i}`}>Compte LinkedIn de…</label>
            <input id={`li-${i}`} value={name} maxLength={120} disabled={readOnly} onChange={(e) => setAccounts(accounts.map((a, j) => (j === i ? e.target.value : a)))}
              placeholder="Prénom Nom" className={FIELD} />
            <UploadBox api={api} projectId={view.project.id} step="linkedin" files={[]} account={name} onChanged={onChanged} onActive={onActive} disabled={readOnly || api.preview} />
          </div>
        ))}
        <button type="button" onClick={() => setAccounts([...accounts, ""])} disabled={readOnly} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-violet-strong hover:underline" data-add-account>
          <Plus size={14} aria-hidden /> Ajouter un autre compte
        </button>
      </div>
      {files.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-semibold">Archives reçues</p>
          <UploadList view={view} api={api} files={files} readOnly={readOnly} onChanged={onChanged} />
        </div>
      )}
      <Actions>
        <Primary onClick={onContinue} disabled={readOnly || !files.length || uploading} data-continue>Continuer <ArrowRight size={18} aria-hidden /></Primary>
        <Quiet onClick={onLater} disabled={readOnly || uploading} data-later>{later ? "Toujours plus tard" : "Je l'ajouterai plus tard"}</Quiet>
      </Actions>
    </section>
  );
}

/** Liste des fichiers reçus d'une étape (réutilise l'affichage du dépôt, sans zone d'envoi). */
function UploadList({ view, api, files, readOnly, onChanged }: { view: DiscoveryView; api: FlowApi; files: DiscoveryView["files"]; readOnly: boolean; onChanged: () => void }) {
  async function remove(id: string, name: string) {
    if (!window.confirm(`Retirer « ${name} » de l'onboarding ?`)) return;
    if ((await api.fileRemove(id)).ok) onChanged();
  }
  return (
    <ul className="divide-y divide-line border-y border-line" data-upload-files>
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
          <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-semibold">{f.account ? `${f.account} · ` : ""}{f.name}</span>
          {f.mine && !readOnly && view.project.id && <button type="button" onClick={() => remove(f.id, f.name)} className="rounded p-1 text-xs text-muted hover:bg-surface">Retirer</button>}
        </li>
      ))}
    </ul>
  );
}

function Target({ index, view, api, readOnly, setView, reload, react, onHandled, onNext, setPrimary }: {
  index: number; view: DiscoveryView; api: FlowApi; readOnly: boolean; setView: React.Dispatch<React.SetStateAction<DiscoveryView>>;
  reload: () => Promise<DiscoveryView | null>; react: (m: Mood, line: string, confetti?: boolean) => void;
  onHandled: (v: DiscoveryView) => Promise<void>; onNext: () => void; setPrimary: SetPrimary;
}) {
  const t = view.targets[index];
  const [comment, setComment] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<TargetField, string>>>({});
  const editable = (f: TargetField) => !readOnly && (!t[f] || t.client_filled.includes(f));
  const handled = targetHandled(t);
  usePrimary(setPrimary, handled && comment === null ? onNext : null);

  const update = (patch: Partial<DiscoveryTarget>): DiscoveryView => {
    const apply = (v: DiscoveryView) => ({ ...v, targets: v.targets.map((x) => (x.position === t.position ? { ...x, ...patch } : x)) });
    setView(apply);
    return apply(view);
  };

  async function fill(field: TargetField) {
    const value = (drafts[field] ?? t[field]).trim();
    if (value === t[field]) return;
    const r = await api.targetFill(t.position, field, value, t.rev);
    if (!r.ok) return react("think", r.network ? MASCOT_LINES.offline : r.error);
    if (!r.data.ok) { await reload(); return react("think", `${OWNER_FIRST_NAME} vient de modifier cette cible : relis-la.`); }
    update({ [field]: value, rev: r.data.rev, client_filled: value ? [...new Set([...t.client_filled, field])] : t.client_filled.filter((x) => x !== field) });
    setDrafts((d) => ({ ...d, [field]: undefined }));
  }

  async function validate(valid: boolean) {
    const r = await api.targetValidate(t.position, t.rev, valid);
    if (!r.ok) return react("think", r.network ? MASCOT_LINES.offline : r.error);
    if (!r.data.ok) { await reload(); return react("think", `${OWNER_FIRST_NAME} vient de modifier cette cible : relis-la avant de valider.`); }
    const nv = update({ validated_at: valid ? new Date().toISOString() : null, validated_by: valid ? view.me?.first_name ?? null : null, modified_since_validation: false });
    if (valid) {
      react("happy", index < 2 ? "Validée ! Au suivant." : "Validée !");
      await onHandled(nv);
    }
  }

  async function sendComment() {
    const body = (comment ?? "").trim();
    if (!body) return;
    const r = await api.targetComment(t.position, body);
    if (!r.ok) return react("think", r.network ? MASCOT_LINES.offline : r.error);
    const nv = update({ comments: [...t.comments, { id: crypto.randomUUID(), body, by: view.me?.first_name ?? null, mine: true, at: new Date().toISOString() }] });
    setComment(null);
    react("happy", `Noté, ${OWNER_FIRST_NAME} reviendra vers toi là-dessus.`);
    await onHandled(nv);
  }
  const { run: runComment } = useOnce(sendComment);
  const nextLabel = <>{index < 2 ? "Cible suivante" : "Voir le récapitulatif"} <ArrowRight size={16} aria-hidden /></>;
  const small = "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-base outline-none placeholder:text-muted/60 focus:border-violet focus:ring-2 focus:ring-violet/20";

  return (
    <section className="space-y-8" data-target-screen={t.position}>
      <div className="space-y-3">
        <Eyebrow>Étape 6 · cible {index + 1} sur 3</Eyebrow>
        <Big>{t.name || `Cible ${index + 1}`}</Big>
        {t.modified_since_validation && <p className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-warning" data-modified>Modifiée depuis ta validation</p>}
      </div>
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {TARGET_FIELDS.map((f) => (
          <div key={f.key} className={f.multiline || f.key === "name" ? "sm:col-span-2" : ""}>
            <dt><label htmlFor={`t-${t.position}-${f.key}`} className="font-label text-xs font-semibold tracking-wide text-muted uppercase">{f.label}</label></dt>
            <dd>
              {editable(f.key) ? (
                <>
                  {f.multiline ? (
                    <textarea id={`t-${t.position}-${f.key}`} rows={2} value={drafts[f.key] ?? t[f.key]} maxLength={2000} placeholder={`À toi de compléter · ${f.placeholder}`}
                      onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })} onBlur={() => void fill(f.key)} className={small} />
                  ) : (
                    <input id={`t-${t.position}-${f.key}`} value={drafts[f.key] ?? t[f.key]} maxLength={f.key === "roles" ? 500 : 300} placeholder={`À toi de compléter · ${f.placeholder}`}
                      onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })} onBlur={() => void fill(f.key)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} className={small} />
                  )}
                  {t.client_filled.includes(f.key) && <span className="text-[11px] text-muted">Complété par ton équipe</span>}
                </>
              ) : (
                <p className="mt-0.5 text-base whitespace-pre-wrap">{t[f.key] || <span className="text-muted">—</span>}</p>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {t.comments.length > 0 && (
        <ul className="space-y-2">
          {t.comments.map((c) => <li key={c.id} className="flex gap-2 rounded-lg bg-surface px-3 py-2 text-sm"><MessageSquare size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden /><span className="whitespace-pre-wrap">{c.body}<span className="block text-[11px] text-muted">{c.by ?? "Toi"}</span></span></li>)}
        </ul>
      )}
      {comment !== null ? (
        <div className="space-y-2">
          <label htmlFor={`c-${t.position}`} className="text-sm font-semibold">Ton commentaire sur cette cible</label>
          <textarea id={`c-${t.position}`} autoFocus rows={3} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : plutôt les entreprises de plus de 200 personnes, et pas le secteur public."
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.repeat && !isTouch()) { e.preventDefault(); void runComment(); } }} className={FIELD} />
          <Actions>
            <Primary onClick={runComment} disabled={!comment.trim()} data-comment-send>Envoyer le commentaire</Primary>
            <Quiet onClick={() => setComment(null)}>Annuler</Quiet>
          </Actions>
        </div>
      ) : (
        <Actions>
          {t.validated_at ? (
            <>
              <Primary onClick={onNext} data-next-target>{nextLabel}</Primary>
              <span className="inline-flex min-h-11 items-center gap-1.5 px-1 text-sm font-semibold text-success" data-validated><CheckCircle2 size={16} aria-hidden /> Validée</span>
              {!readOnly && <Quiet onClick={() => validate(false)}>Annuler ma validation</Quiet>}
            </>
          ) : (
            <Primary onClick={() => validate(true)} disabled={readOnly} data-validate><Check size={18} aria-hidden /> Je valide</Primary>
          )}
          <Quiet onClick={() => setComment("")} disabled={readOnly} data-comment><MessageSquare size={15} aria-hidden /> Ajouter un commentaire</Quiet>
          {handled && !t.validated_at && <Quiet onClick={onNext} data-next-target>{nextLabel}</Quiet>}
        </Actions>
      )}
    </section>
  );
}

function Recap({ view, api, readOnly, jump, uploading, onSent }: { view: DiscoveryView; api: FlowApi; readOnly: boolean; jump: (id: string) => void; uploading: boolean; onSent: (already: boolean) => void }) {
  const [sending, setSending] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const lock = useRef(false);
  const missing = useMemo(() => {
    const m: { id: string; label: string }[] = [];
    // « Je ne sais pas » compte comme traité : la question ne bloque pas, elle ressort chez Célien
    OFFER_QUESTIONS.forEach((q, i) => { if (!q.optional && !view.answers[q.key]?.value && !view.answers[q.key]?.unknown) m.push({ id: `offer:${i}`, label: q.title }); });
    if (view.steps.lemlist?.status !== "done") m.push({ id: "lemlist", label: "Invitation lemlist" });
    if (!stepComplete(view, "blacklist")) m.push({ id: "blacklist", label: "Blacklist (ou « Je n'en ai pas »)" });
    if (!stepComplete(view, "linkedin")) m.push({ id: "linkedin", label: view.steps.linkedin?.status === "later" ? "Archive LinkedIn (prévue plus tard : tu pourras l'ajouter après l'envoi)" : "Archive LinkedIn" });
    view.targets.forEach((t, i) => { if (!targetHandled(t)) m.push({ id: `targets:${i}`, label: `Cible ${i + 1} à valider ou commenter` }); });
    return m;
  }, [view]);

  async function send() {
    if (lock.current || readOnly) return; // double clic : un seul envoi (la base le garantit aussi)
    if (missing.length && !confirmMissing && !view.sent_at) { setConfirmMissing(true); return; }
    lock.current = true;
    setSending(true);
    const r = await api.send();
    setSending(false);
    lock.current = false;
    if (r.ok) onSent(r.data.already);
  }

  const files = (step: string) => view.files.filter((f) => f.step === step);
  const status = (k: "blacklist" | "linkedin" | "documents") => {
    const f = files(k);
    if (f.length) return f.map((x) => <p key={x.id}>{x.account ? `${x.account} · ` : ""}{x.name}</p>);
    const st = view.steps[k]?.status;
    return <p className="text-muted">{st === "none" ? (k === "blacklist" ? "Pas de blacklist" : "Rien à ajouter") : st === "later" ? "Prévu plus tard" : "Pas encore fait"}</p>;
  };
  const site = view.answers[WEBSITE_KEY]?.value;
  const siteScreen = `offer:${OFFER_QUESTIONS.findIndex((q) => q.key === WEBSITE_FIELD.question)}`;
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Big>Ton récapitulatif</Big>
        {view.sent_at ? (
          <p className="rounded-lg bg-surface p-3 text-sm" data-already-sent>
            Envoyé le {new Date(view.sent_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}{view.sent_by ? ` par ${view.sent_by}` : ""}. Tu peux encore corriger : {OWNER_FIRST_NAME} verra ce qui a changé.
          </p>
        ) : <p className="text-base text-muted">Relis, corrige si besoin, puis envoie. Tu pourras encore modifier après.</p>}
      </div>
      <div className="divide-y divide-line border-y border-line">
        <RecapRow readOnly={readOnly} jump={jump} id="offer:0" title="Ton offre">
          <dl className="space-y-3">
            {OFFER_QUESTIONS.map((q, i) => {
              const a = view.answers[q.key];
              return (
                <div key={q.key}>
                  <dt className="text-xs font-semibold text-muted">{q.title}</dt>
                  <dd className="whitespace-pre-wrap">
                    {a?.value ? a.value
                      : a?.unknown ? <button type="button" onClick={() => jump(`offer:${i}`)} className="text-left text-muted hover:underline" data-recap-unknown>{UNKNOWN.label} · on complétera ensemble</button>
                      : <button type="button" onClick={() => jump(`offer:${i}`)} className="text-violet-strong underline">À compléter</button>}
                  </dd>
                </div>
              );
            })}
            {site && (
              <div>
                <dt className="text-xs font-semibold text-muted">Lien du site</dt>
                <dd><button type="button" onClick={() => jump(siteScreen)} className="text-left break-all hover:underline" data-recap-website>{site}</button></dd>
              </div>
            )}
          </dl>
        </RecapRow>
        <RecapRow readOnly={readOnly} jump={jump} id="lemlist" title="lemlist">{view.steps.lemlist?.status === "done" ? <p>Invitation envoyée</p> : <p className="text-muted">Pas encore confirmé</p>}</RecapRow>
        <RecapRow readOnly={readOnly} jump={jump} id="blacklist" title="Blacklist">{status("blacklist")}</RecapRow>
        <RecapRow readOnly={readOnly} jump={jump} id="linkedin" title="Archives LinkedIn">{status("linkedin")}</RecapRow>
        <RecapRow readOnly={readOnly} jump={jump} id="documents" title="Autres documents">{status("documents")}</RecapRow>
        <RecapRow readOnly={readOnly} jump={jump} id="targets:0" title="Tes 3 cibles">
          {view.targets.map((t, i) => (
            <p key={t.position}>
              <button type="button" onClick={() => jump(`targets:${i}`)} className="font-semibold hover:underline">{t.name || `Cible ${i + 1}`}</button>
              {" · "}{t.validated_at ? "validée" : t.comments.length ? `commentée (${t.comments.length})` : <span className="text-muted">à valider</span>}
            </p>
          ))}
        </RecapRow>
      </div>
      {confirmMissing && missing.length > 0 && !view.sent_at && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm" role="alert" data-missing>
          <p className="font-semibold text-warning">Il manque encore :</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{missing.map((m) => <li key={m.id}><button type="button" onClick={() => jump(m.id)} className="text-left underline">{m.label}</button></li>)}</ul>
          <p className="mt-2">Tu peux envoyer quand même et compléter plus tard.</p>
        </div>
      )}
      {!view.sent_at && (
        <Actions>
          <button type="button" onClick={() => void send()} disabled={sending || readOnly || uploading} data-send
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-ink px-6 text-base font-semibold text-white hover:bg-violet-strong disabled:opacity-40 sm:w-auto">
            {sending ? "Envoi…" : confirmMissing && missing.length ? `Envoyer quand même à ${OWNER_FIRST_NAME}` : `Envoyer à ${OWNER_FIRST_NAME}`} <ArrowRight size={18} aria-hidden />
          </button>
          {uploading && <span className="text-xs text-muted">Un fichier est encore en cours d&apos;envoi.</span>}
        </Actions>
      )}
    </section>
  );
}

function RecapRow({ id, title, children, readOnly, jump }: { id: string; title: string; children: React.ReactNode; readOnly: boolean; jump: (id: string) => void }) {
  return (
    <div className="py-4" data-recap={id}>
      <div className="flex items-center gap-2">
        <h2 className="font-display text-base font-bold">{title}</h2>
        {!readOnly && <button type="button" onClick={() => jump(id)} className="-my-2 ml-auto inline-flex min-h-11 items-center text-sm font-semibold text-violet-strong hover:underline">Corriger</button>}
      </div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function Sent({ view, onReview, exitHref }: { view: DiscoveryView; onReview: () => void; exitHref: string }) {
  return (
    <section className="space-y-8" data-sent>
      <div className="space-y-3">
        <Big>Merci{view.me?.first_name ? ` ${view.me.first_name}` : ""}, c&apos;est envoyé !</Big>
        <p className="text-base text-muted">Ton test de {OFFER.days} jours peut démarrer. La suite :</p>
      </div>
      <ol className="divide-y divide-line border-y border-line">
        {AFTER_SEND.map((a, i) => (
          <li key={a} className="flex gap-4 py-3 text-sm">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-violet-soft font-label text-sm font-semibold text-violet-strong" aria-hidden>{i + 1}</span>
            <span className="pt-1">{a}</span>
          </li>
        ))}
      </ol>
      {view.steps.linkedin?.status === "later" && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-warning">N&apos;oublie pas ton archive LinkedIn : dès que tu reçois l&apos;email de LinkedIn, reviens ici, étape « LinkedIn ».</p>
      )}
      <Actions>
        <Link href={exitHref} className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-ink px-6 text-base font-semibold text-white hover:bg-violet-strong sm:w-auto">Retour à mon espace</Link>
        <Quiet onClick={onReview} data-review>Revoir mes réponses</Quiet>
      </Actions>
    </section>
  );
}
