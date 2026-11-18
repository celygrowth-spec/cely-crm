"use client";

// Mascotte Cely de l'onboarding. Aucune illustration officielle n'existe dans le dépôt : ce dessin SVG est PROVISOIRE.
// Pour la remplacer : déposer le fichier (SVG ou PNG transparent, carré) dans public/brand/ et renseigner MASCOT_SRC
// dans src/components/portal/mascot.tsx (même réglage que la mascotte du portail). Les humeurs restent animées en CSS.
import { useEffect, useState } from "react";
import { MASCOT_SRC } from "@/components/portal/mascot";
import s from "./flow.module.css";

export type Mood = "idle" | "happy" | "cheer" | "think" | "wave";
const MOOD_CLASS: Record<Mood, string> = { idle: s.idle, happy: s.happy, cheer: s.cheer, think: s.think, wave: s.wave };

export function Mascot({ mood = "idle", size = 96 }: { mood?: Mood; size?: number }) {
  if (MASCOT_SRC) {
    return (
      <span className={`${s.mascot} ${MOOD_CLASS[mood]} inline-block`} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- visuel de marque statique */}
        <img src={MASCOT_SRC} alt="" width={size} height={size} draggable={false} />
      </span>
    );
  }
  const smile = mood === "think" ? "M40 66 Q50 64 60 66" : mood === "cheer" || mood === "happy" ? "M37 62 Q50 76 63 62" : "M39 63 Q50 71 61 63";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`${s.mascot} ${MOOD_CLASS[mood]}`} aria-hidden data-mascot={mood}>
      <defs>
        <radialGradient id="cely-body" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6d28d9" />
        </radialGradient>
      </defs>
      <g className={s.sprout}>
        <path d="M50 22 C50 14 50 10 50 8" stroke="#16a34a" strokeWidth="3" strokeLinecap="round" fill="none" />
        <path d="M50 12 C42 4 34 8 34 12 C40 15 46 15 50 12Z" fill="#22c55e" />
        <path d="M50 10 C58 1 67 5 67 9 C61 13 54 13 50 10Z" fill="#4ade80" />
      </g>
      <ellipse cx="50" cy="92" rx="22" ry="4" fill="#0f172a" opacity=".08" />
      <path d="M50 20 C74 20 86 38 86 58 C86 78 70 90 50 90 C30 90 14 78 14 58 C14 38 26 20 50 20Z" fill="url(#cely-body)" />
      <path d="M22 60 C14 62 10 70 14 74" stroke="#6d28d9" strokeWidth="6" strokeLinecap="round" fill="none" />
      <g className={s.arm}>
        <path d={mood === "cheer" || mood === "wave" ? "M78 58 C88 50 92 40 88 34" : "M78 60 C86 62 90 70 86 74"} stroke="#6d28d9" strokeWidth="6" strokeLinecap="round" fill="none" />
      </g>
      <g className={s.eyes}>
        {mood === "cheer" ? (
          <>
            <path d="M33 47 Q38 41 43 47" stroke="#1e1b4b" strokeWidth="3.5" strokeLinecap="round" fill="none" />
            <path d="M57 47 Q62 41 67 47" stroke="#1e1b4b" strokeWidth="3.5" strokeLinecap="round" fill="none" />
          </>
        ) : (
          <>
            <ellipse cx="38" cy="47" rx="5.5" ry="6.5" fill="#fff" />
            <ellipse cx="62" cy="47" rx="5.5" ry="6.5" fill="#fff" />
            <circle cx={mood === "think" ? 40 : 39} cy={mood === "think" ? 45 : 48} r="3" fill="#1e1b4b" />
            <circle cx={mood === "think" ? 64 : 63} cy={mood === "think" ? 45 : 48} r="3" fill="#1e1b4b" />
          </>
        )}
      </g>
      <circle cx="29" cy="60" r="4" fill="#f9a8d4" opacity=".7" />
      <circle cx="71" cy="60" r="4" fill="#f9a8d4" opacity=".7" />
      <path d={smile} stroke="#1e1b4b" strokeWidth="3" strokeLinecap="round" fill={mood === "cheer" || mood === "happy" ? "#1e1b4b" : "none"} />
    </svg>
  );
}

const COLORS = ["#7c3aed", "#a78bfa", "#22c55e", "#f59e0b", "#ec4899", "#38bdf8"];
/** Petite pluie de confettis (CSS). `burst` change → nouvelle salve. Rien si l'utilisateur réduit les mouvements. */
export function Confetti({ burst }: { burst: number }) {
  const [pieces, setPieces] = useState<{ x: number; y: number; r: number; d: number; c: string }[]>([]);
  useEffect(() => {
    if (!burst) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const next = Array.from({ length: 18 }, (_, i) => ({
      x: Math.round(Math.cos((i / 18) * Math.PI * 2) * (60 + Math.random() * 90)),
      y: Math.round(Math.sin((i / 18) * Math.PI * 2) * (40 + Math.random() * 70) - 40),
      r: Math.round(Math.random() * 540 - 270),
      d: Math.round(Math.random() * 120),
      c: COLORS[i % COLORS.length],
    }));
    const t0 = window.setTimeout(() => setPieces(next), 0);
    const t1 = window.setTimeout(() => setPieces([]), 1400);
    return () => { window.clearTimeout(t0); window.clearTimeout(t1); };
  }, [burst]);
  if (!pieces.length) return null;
  return (
    <span className={s.confetti} aria-hidden key={burst}>
      {pieces.map((p, i) => (
        <i key={i} style={{ "--x": `${p.x}px`, "--y": `${p.y}px`, "--r": `${p.r}deg`, "--d": `${p.d}ms`, "--c": p.c } as React.CSSProperties} />
      ))}
    </span>
  );
}

/** La mascotte et sa bulle. `say` change → la bulle réapparaît. */
export function Guide({ mood, say, burst, size = 88 }: { mood: Mood; say: string; burst: number; size?: number }) {
  return (
    <div className="flex items-end gap-3" data-guide>
      <span className="relative shrink-0">
        <Mascot mood={mood} size={size} key={`${mood}-${burst}`} />
        <Confetti burst={burst} />
      </span>
      {say && (
        <p key={say} role="status" aria-live="polite" className={`${s.bubble} relative mb-6 max-w-sm rounded-2xl rounded-bl-sm bg-white px-4 py-2.5 text-[15px] leading-snug font-medium text-ink shadow-[0_6px_24px_-8px_rgba(76,29,149,.35)] ring-1 ring-violet-100`}>
          {say}
        </p>
      )}
    </div>
  );
}
