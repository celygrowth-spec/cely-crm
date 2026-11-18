"use client";

// Onboarding de l'offre découverte, côté client : plein écran, une question par écran, Entrée pour valider,
// barre de progression, sauvegarde à chaque réponse (et brouillon local tant que le réseau manque), reprise exacte.
// Deux contacts en même temps : une réponse modifiée entre-temps n'est jamais écrasée sans le montrer.
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock, Copy, CornerDownLeft, ExternalLink, ImageIcon, MessageSquare, PartyPopper, Plus, X } from "lucide-react";
import {
  AFTER_SEND, BLACKLIST_HELP, DOCUMENTS_HELP, LEMLIST_TUTO, LEMLIST_URL, LINKEDIN_EXPORT_URL, LINKEDIN_TUTO, MASCOT_LINES, OFFER, OFFER_QUESTIONS,
  OWNER_FIRST_NAME, STEPS, TARGET_FIELDS, TIMELINE, type StepKey, type TutoStep,
} from "@/lib/discovery/content";
import { stepComplete, targetHandled, type DiscoveryTarget, type DiscoveryView, type StepStatus, type TargetField } from "@/lib/discovery/types";
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

type Conflict = { key: string; mine: string; theirs: string; by: string | null; rev: number };
type SaveState = "idle" | "saving" | "saved" | "offline";

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
  const pending = useRef(new Map<string, string>());
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
    moodTimer.current = window.setTimeout(() => setMood("idle"), m === "cheer" ? 1900 : 900);
  }, []);
  const celebrate = useCallback((line?: string) => react("cheer", line ?? pick(MASCOT_LINES.stepDone), true), [react]);

  // --- reprise exacte : l'écran courant est enregistré à chaque changement ---
  useEffect(() => {
    if (readOnly) return;
    const t = window.setTimeout(() => { void api.position(screen.id); }, 300);
    return () => window.clearTimeout(t);
  }, [api, screen.id, readOnly]);

  // --- réponses : sauvegarde, conflit, brouillon hors ligne ---
  const saveAnswer = useCallback(async (key: string, raw: string, force?: number): Promise<boolean> => {
    const value = raw.trim();
    const cur = viewRef.current.answers[key];
    if ((cur?.value ?? "") === value && force === undefined) { writeDraft(project, key, null); return true; }
    writeDraft(project, key, value);
    setSave("saving");
    const r = await api.answer(key, value, force ?? cur?.rev ?? 0);
    if (!r.ok) {
      if (r.network) { pending.current.set(key, value); setSave("offline"); return true; } // brouillon gardé, renvoyé au retour du réseau
      setSave("idle");
      react("think", r.error);
      return false;
    }
    if (!r.data.ok) {
      setSave("idle");
      setConflict({ key, mine: value, theirs: r.data.value, by: r.data.by, rev: r.data.rev });
      react("think", MASCOT_LINES.conflict);
      return false;
    }
    const rev = r.data.rev;
    pending.current.delete(key);
    writeDraft(project, key, null);
    setView((v) => {
      const nv = { ...v, answers: { ...v.answers, [key]: { value, rev, by: v.me?.first_name ?? null, mine: true, at: new Date().toISOString() } } };
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
      const d = readDraft(project, q.key);
      if (d !== null && d !== (initial.answers[q.key]?.value ?? "")) pending.current.set(q.key, d);
    }
    const flush = () => { for (const [k, v] of pending.current) void saveAnswer(k, v); };
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
    if (newlyDone) celebrate(line);
    else if (line) react("happy", line);
    return true;
  }, [api, celebrate, react]);

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
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
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

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gradient-to-b from-[#f7f4ff] via-white to-[#f3fbf6] text-ink" data-discovery-flow data-screen={screen.id}>
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={62} height={22} priority />
          <span className="hidden text-sm font-semibold text-muted sm:inline">Onboarding · {OFFER.name}</span>
          <span className="ml-auto text-xs text-muted" aria-live="polite" data-save={save}>
            {api.preview ? <strong className="text-amber-700">Aperçu : rien n&apos;est enregistré</strong>
              : save === "saving" ? "Enregistrement…" : save === "saved" ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={12} aria-hidden /> Enregistré</span>
              : save === "offline" ? <span className="text-amber-700">Hors ligne : gardé sur cet appareil</span> : null}
          </span>
          <Link href={exitHref} className="rounded-lg p-2 text-muted hover:bg-violet-50 hover:text-ink" aria-label="Quitter l'onboarding (tout est enregistré)" title="Quitter (tout est enregistré)"><X size={18} /></Link>
        </div>
        <div className="h-1.5 bg-violet-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progression de l'onboarding">
          <div className={`cob-progress h-full rounded-r-full bg-gradient-to-r from-violet-500 to-emerald-400`} style={{ width: `${progress}%` }} />
        </div>
        {currentStep > 0 && screen.step !== "sent" && (
          <ol className="mx-auto hidden max-w-3xl gap-1 px-4 py-2 md:flex" aria-label="Étapes">
            {STEPS.slice(1).map((st, i) => {
              const done = stepComplete(view, st.key);
              const on = st.key === screen.step;
              return (
                <li key={st.key} className="min-w-0 flex-1">
                  <button type="button" onClick={() => jump(SCREENS.find((x) => x.step === st.key)!.id)}
                    className={`flex w-full items-center gap-1 truncate rounded-full px-2 py-1 text-[11px] font-semibold ${on ? "bg-violet-600 text-white" : done ? "bg-emerald-50 text-emerald-700" : "text-muted hover:bg-violet-50"}`}
                    aria-current={on ? "step" : undefined}>
                    {done ? <Check size={11} aria-hidden /> : <span aria-hidden>{i + 1}.</span>} {st.short}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </header>

      <main ref={mainRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 pt-6 pb-28 outline-none sm:pt-10">
        {readOnly && <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Ce projet est archivé : l&apos;onboarding est consultable mais plus modifiable.</p>}
        <div className="mb-6">
          <Guide mood={mood} say={say} burst={burst} size={screen.id === "welcome" || screen.id === "sent" ? 112 : 80} />
        </div>
        <div key={screen.id} className={"cob-screenIn"}>
          {screen.id === "welcome" && <Welcome onStart={() => { void markStep("welcome", "done"); react("happy", "C'est parti !"); next(); }} setPrimary={setPrimary} firstName={firstName} />}
          {screen.step === "offer" && (
            <OfferQuestion
              key={screen.id} index={screen.sub!} view={view} project={project} readOnly={readOnly} conflict={conflict?.key === OFFER_QUESTIONS[screen.sub!].key ? conflict : null}
              onSubmit={async (value) => {
                const q = OFFER_QUESTIONS[screen.sub!];
                const ok = value.trim() ? await saveAnswer(q.key, value) : true;
                if (!ok) return;
                const last = screen.sub === OFFER_QUESTIONS.length - 1;
                if (last) await markStep("offer", "done", "Merci ! Avec ça, je peux écrire des messages qui te ressemblent.");
                else if (value.trim()) react("happy", pick(MASCOT_LINES.offerAnswered));
                next();
              }}
              onResolve={async (keepMine) => {
                if (!conflict) return;
                if (keepMine) { if (await saveAnswer(conflict.key, conflict.mine, conflict.rev)) setConflict(null); }
                else {
                  setView((v) => ({ ...v, answers: { ...v.answers, [conflict.key]: { value: conflict.theirs, rev: conflict.rev, by: conflict.by, mine: false, at: new Date().toISOString() } } }));
                  writeDraft(project, conflict.key, null);
                  setConflict(null);
                }
              }}
            />
          )}
          {screen.id === "lemlist" && <Lemlist view={view} readOnly={readOnly} setPrimary={setPrimary} onDone={async () => { await markStep("lemlist", "done", "Top, je surveille l'invitation !"); next(); }} />}
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
            onSent={(already) => { void reload(); celebrate(already ? "C'était déjà envoyé : tout est bien arrivé !" : MASCOT_LINES.sent); go(SCREENS.length - 1); }} />}
          {screen.id === "sent" && <Sent view={view} onReview={() => jump("recap")} exitHref={exitHref} />}
        </div>
      </main>

      {idx > 0 && screen.id !== "sent" && (
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-violet-100 bg-white/90 backdrop-blur" aria-label="Navigation de l'onboarding">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2.5">
            <button type="button" onClick={() => go(idx - 1)} className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:bg-violet-50 hover:text-ink">
              <ArrowLeft size={16} aria-hidden /> Retour
            </button>
            <span className="mx-auto text-xs text-muted">{screen.step === "recap" ? "Dernière étape" : `Étape ${currentStep} sur ${STEPS.length - 1}`}</span>
            {screen.id !== "recap" && (
              <button type="button" onClick={next} className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold text-muted hover:bg-violet-50 hover:text-ink" data-skip>
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
function Big({ children }: { children: React.ReactNode }) {
  return <h1 className="font-display text-[1.75rem] leading-tight font-extrabold tracking-tight text-ink sm:text-4xl">{children}</h1>;
}
function Primary({ children, onClick, disabled, ...rest }: { children: React.ReactNode; onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string | boolean>) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}
      className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-violet-600 px-6 py-3 text-base font-bold text-white shadow-[0_8px_20px_-8px_rgba(109,40,217,.7)] transition hover:bg-violet-700 active:scale-[.98] disabled:opacity-50">
      {children}
    </button>
  );
}
function Secondary({ children, onClick, disabled, ...rest }: { children: React.ReactNode; onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string | boolean>) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}
      className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-base font-semibold text-ink ring-1 ring-violet-200 hover:bg-violet-50 disabled:opacity-50">
      {children}
    </button>
  );
}
const EnterHint = () => <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">ou appuie sur <kbd className="inline-flex items-center gap-0.5 rounded border border-line bg-white px-1.5 py-0.5 font-sans font-semibold">Entrée <CornerDownLeft size={11} aria-hidden /></kbd></span>;

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
    <section className="space-y-6">
      <Big>{firstName ? `${firstName}, ` : ""}bienvenue dans ton test de {OFFER.days} jours 👋</Big>
      <p className="text-lg text-muted">{OFFER.contacts} contacts, {OFFER.targets} cibles, {OFFER.channels}. Ici, tu me donnes tout ce qu&apos;il faut pour lancer : environ <strong className="text-ink">{OFFER.estimatedMinutes} minutes</strong>, et tu peux t&apos;arrêter quand tu veux, tout est enregistré.</p>
      <ol className="grid gap-3 sm:grid-cols-3">
        {TIMELINE.map((t, i) => (
          <li key={t.when} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-violet-100">
            <span className="text-xs font-bold text-violet-600 uppercase">{t.when}</span>
            <p className="mt-1 text-sm">{t.what}</p>
            <span className="sr-only">Phase {i + 1}</span>
          </li>
        ))}
      </ol>
      <div className="rounded-2xl bg-emerald-50 p-4">
        <p className="font-semibold text-emerald-900">À avoir sous la main</p>
        <ul className="mt-2 space-y-1.5 text-sm text-emerald-900">
          {MASCOT_LINES.welcomeKit.map((k) => <li key={k} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0" aria-hidden /> {k}</li>)}
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={onStart} data-start>C&apos;est parti <ArrowRight size={18} aria-hidden /></Primary>
        <EnterHint />
      </div>
    </section>
  );
}

function OfferQuestion({ index, view, project, readOnly, conflict, onSubmit, onResolve }: {
  index: number; view: DiscoveryView; project: string; readOnly: boolean; conflict: Conflict | null;
  onSubmit: (value: string) => Promise<void>; onResolve: (keepMine: boolean) => Promise<void>;
}) {
  const q = OFFER_QUESTIONS[index];
  const saved = view.answers[q.key];
  const [value, setValue] = useState(() => readDraft(project, q.key) ?? saved?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [example, setExample] = useState(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { if (!isTouch()) ref.current?.focus(); }, []);
  // version adoptée après un conflit : le champ suit la réponse retenue
  const [seenRev, setSeenRev] = useState(saved?.rev ?? 0);
  if (saved && saved.rev !== seenRev && !saved.mine) { setSeenRev(saved.rev); setValue(saved.value); }

  // brouillon local à chaque frappe : une coupure ou une fermeture d'onglet ne perd rien
  const onChange = (v: string) => { setValue(v); writeDraft(project, q.key, v); };
  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    await onSubmit(value);
    setBusy(false);
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !(q.multiline && isTouch())) { e.preventDefault(); void submit(); }
  };
  const field = "w-full rounded-2xl border-0 bg-white px-4 py-3 text-lg shadow-sm ring-1 ring-violet-200 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-violet-500 sm:text-xl";
  return (
    <section className="space-y-5" data-question={q.key}>
      <p className="text-sm font-bold text-violet-600">Question {index + 1} sur {OFFER_QUESTIONS.length}{q.optional ? " · facultative" : ""}</p>
      <Big><label htmlFor={`q-${q.key}`}>{q.title}</label></Big>
      <p className="text-base text-muted sm:text-lg">{q.help}</p>
      {q.multiline ? (
        <textarea id={`q-${q.key}`} ref={ref} value={value} rows={4} maxLength={5000} disabled={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} placeholder={q.placeholder} className={`${field} min-h-32 resize-y`} />
      ) : (
        <input id={`q-${q.key}`} ref={ref} value={value} maxLength={5000} disabled={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} placeholder={q.placeholder} className={field} enterKeyHint="next" />
      )}
      {saved && !saved.mine && saved.by && !conflict && <p className="text-xs text-muted">Réponse de {saved.by}</p>}
      {conflict && (
        <div className="space-y-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200" role="alert" data-conflict>
          <p className="font-semibold text-amber-900">{conflict.by ?? "Quelqu'un de ton équipe"} a modifié cette réponse pendant que tu écrivais :</p>
          <blockquote className="rounded-xl bg-white px-3 py-2 text-sm whitespace-pre-wrap">{conflict.theirs || "(vide)"}</blockquote>
          <div className="flex flex-wrap gap-2">
            <Secondary onClick={() => onResolve(false)} data-keep-theirs>Garder sa version</Secondary>
            <Primary onClick={() => onResolve(true)} data-keep-mine>Garder la mienne</Primary>
          </div>
        </div>
      )}
      {q.example && (
        <button type="button" onClick={() => setExample(!example)} className="text-sm font-semibold text-violet-700 hover:underline">{example ? "Masquer l'exemple" : "Voir un exemple"}</button>
      )}
      {example && q.example && <p className="rounded-xl bg-violet-50 px-3 py-2 text-sm italic">{q.example}</p>}
      {!conflict && (
        <div className="flex flex-wrap items-center gap-3">
          <Primary onClick={submit} disabled={busy || readOnly} data-ok>{value.trim() ? "OK" : "Passer"} <Check size={18} aria-hidden /></Primary>
          <EnterHint />
          {q.multiline && <span className="hidden text-xs text-muted sm:inline">· Maj + Entrée pour aller à la ligne</span>}
        </div>
      )}
    </section>
  );
}

function Tuto({ steps, alt }: { steps: TutoStep[]; alt: string }) {
  return (
    <ol className="space-y-3">
      {steps.map((t, i) => (
        <li key={t.title} className="flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-violet-100">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-violet-600 text-sm font-bold text-white">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t.title}</p>
            <p className="mt-0.5 text-sm text-muted">{t.body}</p>
            {t.image ? (
              <Image src={t.image} alt={`${alt}, étape ${i + 1}`} width={640} height={360} className="mt-2 h-auto w-full rounded-xl ring-1 ring-line" />
            ) : (
              <div className="mt-2 hidden aspect-[16/7] items-center justify-center gap-2 rounded-xl border border-dashed border-violet-200 bg-violet-50/50 text-xs text-violet-400 sm:flex" aria-hidden data-screenshot-slot>
                <ImageIcon size={14} /> Capture à venir
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Lemlist({ view, readOnly, setPrimary, onDone }: { view: DiscoveryView; readOnly: boolean; setPrimary: SetPrimary; onDone: () => Promise<void> }) {
  const email = view.settings.lemlist_invite_email;
  const done = view.steps.lemlist?.status === "done";
  const [copied, setCopied] = useState(false);
  usePrimary(setPrimary, readOnly ? null : () => void onDone());
  return (
    <section className="space-y-5">
      <p className="text-sm font-bold text-violet-600">Étape 2 · environ 3 minutes</p>
      <Big>On crée ton espace lemlist</Big>
      <p className="text-lg text-muted">C&apos;est l&apos;outil qui enverra tes emails et tes messages LinkedIn, depuis ton compte. Tu restes propriétaire de tout ; moi, j&apos;y prépare et pilote les campagnes.</p>
      <Tuto steps={LEMLIST_TUTO} alt="lemlist" />
      <div className="rounded-2xl bg-violet-50 p-4">
        <p className="text-sm font-semibold">L&apos;adresse à inviter</p>
        {email ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-white px-3 py-2 text-base font-semibold" data-invite-email>{email}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(email).then(() => setCopied(true), () => undefined)} className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-semibold text-violet-700 hover:bg-white">
              {copied ? <><Check size={14} aria-hidden /> Copiée</> : <><Copy size={14} aria-hidden /> Copier</>}
            </button>
          </div>
        ) : <p className="mt-1 text-sm text-muted">{OWNER_FIRST_NAME} te communiquera l&apos;adresse à inviter.</p>}
        <a href={LEMLIST_URL} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-violet-700 hover:underline">Ouvrir lemlist <ExternalLink size={13} aria-hidden /></a>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={() => void onDone()} disabled={readOnly} data-lemlist-done>{done ? <><CheckCircle2 size={18} aria-hidden /> C&apos;est fait (confirmé)</> : <>C&apos;est fait <Check size={18} aria-hidden /></>}</Primary>
        <EnterHint />
      </div>
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
    <section className="space-y-5">
      <p className="text-sm font-bold text-violet-600">{blacklist ? "Étape 3 · 1 minute" : "Étape 5 · facultative"}</p>
      <Big>{blacklist ? "Ta blacklist" : "D'autres documents utiles ?"}</Big>
      {blacklist ? (
        <>
          <p className="text-lg text-muted">{BLACKLIST_HELP.why}</p>
          <p className="text-sm text-muted">{BLACKLIST_HELP.format}</p>
        </>
      ) : <p className="text-lg text-muted">{DOCUMENTS_HELP}</p>}
      <UploadBox api={api} projectId={view.project.id} step={step} files={files} multiple onChanged={onChanged} onActive={onActive} disabled={readOnly || api.preview} />
      {api.preview && <p className="text-xs text-amber-700">Aperçu : le dépôt est désactivé.</p>}
      <div className="flex flex-wrap gap-3">
        <Primary onClick={() => void onContinue()} disabled={readOnly || !files.length || uploading} data-continue>Continuer <ArrowRight size={18} aria-hidden /></Primary>
        <Secondary onClick={() => void onNone()} disabled={readOnly || uploading} data-none>{noneLabel}</Secondary>
      </div>
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
    <section className="space-y-5">
      <p className="text-sm font-bold text-violet-600">Étape 4 · 2 minutes maintenant, le reste plus tard</p>
      <Big>Tes archives LinkedIn</Big>
      <p className="text-lg text-muted">Avec ton archive, je retrouve tes connexions et tes échanges : on évite de contacter des gens que tu connais déjà, et on s&apos;appuie sur ton réseau.</p>
      <p className="flex gap-2 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900" data-linkedin-warning>
        <Clock size={18} className="shrink-0" aria-hidden />
        <span><strong>LinkedIn peut mettre jusqu&apos;à 24 h à t&apos;envoyer l&apos;archive.</strong> Demande-la maintenant, choisis « Je l&apos;ajouterai plus tard », et reviens ici quand tu as reçu l&apos;email : l&apos;étape reste ouverte.</span>
      </p>
      <Tuto steps={LINKEDIN_TUTO} alt="LinkedIn" />
      <a href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-violet-700 hover:underline">Ouvrir la page LinkedIn « Télécharger vos données » <ExternalLink size={13} aria-hidden /></a>
      <div className="space-y-4">
        {accounts.map((name, i) => (
          <div key={i} className="space-y-2 rounded-2xl bg-white/60 p-3 ring-1 ring-violet-100" data-linkedin-account={i}>
            <label className="block text-sm font-semibold" htmlFor={`li-${i}`}>Compte LinkedIn de…</label>
            <input id={`li-${i}`} value={name} maxLength={120} disabled={readOnly} onChange={(e) => setAccounts(accounts.map((a, j) => (j === i ? e.target.value : a)))}
              placeholder="Prénom Nom" className="w-full rounded-xl border-0 bg-white px-3 py-2.5 text-base ring-1 ring-violet-200 outline-none focus:ring-2 focus:ring-violet-500" />
            <UploadBox api={api} projectId={view.project.id} step="linkedin" files={[]} account={name} onChanged={onChanged} onActive={onActive} disabled={readOnly || api.preview} />
          </div>
        ))}
        <button type="button" onClick={() => setAccounts([...accounts, ""])} disabled={readOnly} className="inline-flex items-center gap-1 text-sm font-semibold text-violet-700 hover:underline" data-add-account>
          <Plus size={14} aria-hidden /> Ajouter un autre compte
        </button>
      </div>
      {files.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-semibold">Archives reçues</p>
          <UploadList view={view} api={api} files={files} readOnly={readOnly} onChanged={onChanged} />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Primary onClick={() => void onContinue()} disabled={readOnly || !files.length || uploading} data-continue>Continuer <ArrowRight size={18} aria-hidden /></Primary>
        <Secondary onClick={() => void onLater()} disabled={readOnly || uploading} data-later>{later ? "Toujours plus tard" : "Je l'ajouterai plus tard"}</Secondary>
      </div>
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
    <ul className="space-y-1.5" data-upload-files>
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm">
          <CheckCircle2 size={16} className="shrink-0 text-emerald-600" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-semibold">{f.account ? `${f.account} · ` : ""}{f.name}</span>
          {f.mine && !readOnly && view.project.id && <button type="button" onClick={() => remove(f.id, f.name)} className="rounded p-1 text-xs text-muted hover:bg-white">Retirer</button>}
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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    const r = await api.targetValidate(t.position, t.rev, valid);
    setBusy(false);
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
    if (!body || busy) return;
    setBusy(true);
    const r = await api.targetComment(t.position, body);
    setBusy(false);
    if (!r.ok) return react("think", r.network ? MASCOT_LINES.offline : r.error);
    const nv = update({ comments: [...t.comments, { id: crypto.randomUUID(), body, by: view.me?.first_name ?? null, mine: true, at: new Date().toISOString() }] });
    setComment(null);
    react("happy", `Noté, ${OWNER_FIRST_NAME} reviendra vers toi là-dessus.`);
    await onHandled(nv);
  }

  return (
    <section className="space-y-5" data-target-screen={t.position}>
      <p className="text-sm font-bold text-violet-600">Étape 6 · cible {index + 1} sur 3</p>
      <Big>{t.name || `Cible ${index + 1}`}</Big>
      {t.modified_since_validation && <p className="inline-flex rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900" data-modified>Modifiée depuis ta validation</p>}
      <div className="grid gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-violet-100 sm:grid-cols-2">
        {TARGET_FIELDS.map((f) => (
          <div key={f.key} className={f.multiline || f.key === "name" ? "sm:col-span-2" : ""}>
            <label htmlFor={`t-${t.position}-${f.key}`} className="text-xs font-bold text-muted uppercase">{f.label}</label>
            {editable(f.key) ? (
              <>
                {f.multiline ? (
                  <textarea id={`t-${t.position}-${f.key}`} rows={2} value={drafts[f.key] ?? t[f.key]} maxLength={2000} placeholder={`À toi de compléter · ${f.placeholder}`}
                    onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })} onBlur={() => void fill(f.key)}
                    className="mt-1 w-full rounded-xl border-0 bg-violet-50/60 px-3 py-2 text-base ring-1 ring-violet-200 outline-none focus:ring-2 focus:ring-violet-500" />
                ) : (
                  <input id={`t-${t.position}-${f.key}`} value={drafts[f.key] ?? t[f.key]} maxLength={f.key === "roles" ? 500 : 300} placeholder={`À toi de compléter · ${f.placeholder}`}
                    onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })} onBlur={() => void fill(f.key)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                    className="mt-1 w-full rounded-xl border-0 bg-violet-50/60 px-3 py-2 text-base ring-1 ring-violet-200 outline-none focus:ring-2 focus:ring-violet-500" />
                )}
                {t.client_filled.includes(f.key) && <span className="text-[11px] text-violet-600">Complété par ton équipe</span>}
              </>
            ) : (
              <p className="mt-0.5 text-base whitespace-pre-wrap">{t[f.key] || <span className="text-muted">—</span>}</p>
            )}
          </div>
        ))}
      </div>
      {t.comments.length > 0 && (
        <ul className="space-y-1.5">
          {t.comments.map((c) => <li key={c.id} className="flex gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm"><MessageSquare size={14} className="mt-0.5 shrink-0 text-violet-600" aria-hidden /><span className="whitespace-pre-wrap">{c.body}<span className="block text-[11px] text-muted">{c.by ?? "Toi"}</span></span></li>)}
        </ul>
      )}
      {comment !== null ? (
        <div className="space-y-2">
          <label htmlFor={`c-${t.position}`} className="text-sm font-semibold">Ton commentaire sur cette cible</label>
          <textarea id={`c-${t.position}`} autoFocus rows={3} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : plutôt les entreprises de plus de 200 personnes, et pas le secteur public."
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !isTouch()) { e.preventDefault(); void sendComment(); } }}
            className="w-full rounded-2xl border-0 bg-white px-4 py-3 text-base ring-1 ring-violet-200 outline-none focus:ring-2 focus:ring-violet-500" />
          <div className="flex flex-wrap gap-2">
            <Primary onClick={() => void sendComment()} disabled={busy || !comment.trim()} data-comment-send>Envoyer le commentaire</Primary>
            <Secondary onClick={() => setComment(null)}>Annuler</Secondary>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {t.validated_at ? (
            <>
              <span className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-emerald-50 px-4 font-bold text-emerald-700" data-validated><CheckCircle2 size={18} aria-hidden /> Validée</span>
              {!readOnly && <button type="button" onClick={() => void validate(false)} className="text-sm text-muted underline">Annuler ma validation</button>}
            </>
          ) : (
            <Primary onClick={() => void validate(true)} disabled={readOnly || busy} data-validate><Check size={18} aria-hidden /> Je valide</Primary>
          )}
          <Secondary onClick={() => setComment("")} disabled={readOnly} data-comment><MessageSquare size={16} aria-hidden /> Ajouter un commentaire</Secondary>
          {handled && <Secondary onClick={onNext} data-next-target>{index < 2 ? "Cible suivante" : "Voir le récapitulatif"} <ArrowRight size={16} aria-hidden /></Secondary>}
        </div>
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
    OFFER_QUESTIONS.forEach((q, i) => { if (!q.optional && !view.answers[q.key]?.value) m.push({ id: `offer:${i}`, label: q.title }); });
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
    if (f.length) return f.map((x) => <p key={x.id}>✓ {x.account ? `${x.account} · ` : ""}{x.name}</p>);
    const st = view.steps[k]?.status;
    return <p className="text-muted">{st === "none" ? (k === "blacklist" ? "Pas de blacklist" : "Rien à ajouter") : st === "later" ? "Prévu plus tard" : "Pas encore fait"}</p>;
  };
  return (
    <section className="space-y-4">
      <Big>Ton récapitulatif</Big>
      {view.sent_at ? (
        <p className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900" data-already-sent>
          Envoyé le {new Date(view.sent_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}{view.sent_by ? ` par ${view.sent_by}` : ""}. Tu peux encore corriger : {OWNER_FIRST_NAME} verra ce qui a changé.
        </p>
      ) : <p className="text-lg text-muted">Relis, corrige si besoin, puis envoie. Tu pourras encore modifier après.</p>}
      <RecapRow readOnly={readOnly} jump={jump} id="offer:0" title="Ton offre">
        <dl className="space-y-2">
          {OFFER_QUESTIONS.map((q, i) => (
            <div key={q.key}>
              <dt className="text-xs font-semibold text-muted">{q.title}</dt>
              <dd className="whitespace-pre-wrap">{view.answers[q.key]?.value || <button type="button" onClick={() => jump(`offer:${i}`)} className="text-violet-700 underline">À compléter</button>}</dd>
            </div>
          ))}
        </dl>
      </RecapRow>
      <RecapRow readOnly={readOnly} jump={jump} id="lemlist" title="lemlist">{view.steps.lemlist?.status === "done" ? <p>✓ Invitation envoyée</p> : <p className="text-muted">Pas encore confirmé</p>}</RecapRow>
      <RecapRow readOnly={readOnly} jump={jump} id="blacklist" title="Blacklist">{status("blacklist")}</RecapRow>
      <RecapRow readOnly={readOnly} jump={jump} id="linkedin" title="Archives LinkedIn">{status("linkedin")}</RecapRow>
      <RecapRow readOnly={readOnly} jump={jump} id="documents" title="Autres documents">{status("documents")}</RecapRow>
      <RecapRow readOnly={readOnly} jump={jump} id="targets:0" title="Tes 3 cibles">
        {view.targets.map((t, i) => (
          <p key={t.position}>
            <button type="button" onClick={() => jump(`targets:${i}`)} className="font-semibold hover:underline">{t.name || `Cible ${i + 1}`}</button>
            {" · "}{t.validated_at ? "✓ validée" : t.comments.length ? `commentée (${t.comments.length})` : <span className="text-muted">à valider</span>}
          </p>
        ))}
      </RecapRow>
      {confirmMissing && missing.length > 0 && !view.sent_at && (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm ring-1 ring-amber-200" role="alert" data-missing>
          <p className="font-semibold text-amber-900">Il manque encore :</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{missing.map((m) => <li key={m.id}><button type="button" onClick={() => jump(m.id)} className="underline">{m.label}</button></li>)}</ul>
          <p className="mt-2">Tu peux envoyer quand même et compléter plus tard.</p>
        </div>
      )}
      {!view.sent_at && (
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Primary onClick={() => void send()} disabled={sending || readOnly || uploading} data-send>
            {sending ? "Envoi…" : confirmMissing && missing.length ? `Envoyer quand même à ${OWNER_FIRST_NAME}` : `Envoyer à ${OWNER_FIRST_NAME}`} <PartyPopper size={18} aria-hidden />
          </Primary>
          {uploading && <span className="text-xs text-muted">Un fichier est encore en cours d&apos;envoi.</span>}
        </div>
      )}
    </section>
  );
}

function RecapRow({ id, title, children, readOnly, jump }: { id: string; title: string; children: React.ReactNode; readOnly: boolean; jump: (id: string) => void }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-violet-100" data-recap={id}>
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        {!readOnly && <button type="button" onClick={() => jump(id)} className="ml-auto text-sm font-semibold text-violet-700 hover:underline">Corriger</button>}
      </div>
      <div className="mt-2 text-sm">{children}</div>
    </div>
  );
}

function Sent({ view, onReview, exitHref }: { view: DiscoveryView; onReview: () => void; exitHref: string }) {
  return (
    <section className="space-y-5 text-center sm:text-left" data-sent>
      <Big>Merci{view.me?.first_name ? ` ${view.me.first_name}` : ""}, c&apos;est envoyé ! 🎉</Big>
      <p className="text-lg text-muted">Ton test de {OFFER.days} jours peut démarrer. La suite :</p>
      <ol className="space-y-2 text-left">
        {AFTER_SEND.map((a, i) => (
          <li key={a} className="flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-violet-100">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-500 text-sm font-bold text-white">{i + 1}</span>
            <span>{a}</span>
          </li>
        ))}
      </ol>
      {view.steps.linkedin?.status === "later" && (
        <p className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">N&apos;oublie pas ton archive LinkedIn : dès que tu reçois l&apos;email de LinkedIn, reviens ici, étape « LinkedIn ».</p>
      )}
      <div className="flex flex-wrap justify-center gap-3 sm:justify-start">
        <Secondary onClick={onReview} data-review>Revoir mes réponses</Secondary>
        <Link href={exitHref} className="inline-flex min-h-12 items-center rounded-xl px-5 font-semibold text-violet-700 hover:bg-violet-50">Retour à mon espace</Link>
      </div>
    </section>
  );
}
