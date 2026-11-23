"use client";

// Cély, la mascotte officielle de Cely Growth, dans l'onboarding. Le dessin reprend à l'identique le « rig » SVG
// du site celygrowth.com (même tracé du corps, mêmes proportions, mêmes couleurs : rose #E88BF7, prune #1A1128) ;
// seules les poses par humeur sont choisies ici. Aucun fichier image : le SVG est construit par ce composant.
// Les mouvements (flottement, petit saut) restent en CSS et sont coupés si l'utilisateur réduit les animations.
import { useEffect, useState } from "react";
import "./onboarding.css";

export type Mood = "idle" | "happy" | "cheer" | "think" | "wave";
const MOOD_CLASS: Record<Mood, string> = { idle: "cob-idle", happy: "cob-happy", cheer: "cob-cheer", think: "cob-think", wave: "cob-wave" };

const PINK = "#E88BF7";
const PRUNE = "#1A1128";
const BODY = "M-30 -38C-30 -56-23.5-62-9-62H9C23.5-62 30-56 30-38V-23C30-9.5 24-4 11-4H-11C-24-4-30-9.5-30-23Z";
/** Cadre du dessin sur le site : 132 × 112. */
const BOX = { x: -66, y: -104, w: 132, h: 112 };

/** Paramètres d'une pose (mêmes noms que sur le site) : mains gauche / droite, courbure des bras, regard, sourcils, bouche. */
type Pose = { lx: number; ly: number; lb: number; rx: number; ry: number; rb: number; gx: number; gy: number; by: number; bt: number; mw: number; mh: number };
const REST: Pose = { lx: -37, ly: -9, lb: 4, rx: 37, ry: -9, rb: -4, gx: 0, gy: 0, by: 0, bt: 0, mw: 1, mh: 7 };
const POSES: Record<Mood, Pose> = {
  idle: REST,
  // salut du site (« wave ») : bras droit levé
  wave: { ...REST, rx: 36, ry: -66, rb: 10, gx: 0.2, gy: 0.1, by: -2, mw: 1.1, mh: 9 },
  happy: { ...REST, by: -2, mw: 1.1, mh: 9 },
  // satisfaction du site (« celebrate ») : les deux bras levés
  cheer: { ...REST, lx: -30, ly: -70, lb: -6, rx: 30, ry: -70, rb: 6, by: -3, mw: 1.15, mh: 10 },
  think: { ...REST, gx: 0.6, gy: -0.7, by: -1.5, bt: 2, mw: 0.7, mh: 3 },
};

const f2 = (n: number) => Math.round(n * 100) / 100;
function arm(side: -1 | 1, hx: number, hy: number, bend: number) {
  const sx = side * 28.5, sy = -28;
  const dx = hx - sx, dy = hy - sy, len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = sx + dx / 2 + (-dy / len) * bend, cy = sy + dy / 2 + (dx / len) * bend;
  return `M${f2(sx)} ${f2(sy)}Q${f2(cx)} ${f2(cy)} ${f2(hx)} ${f2(hy)}`;
}

export function Mascot({ mood = "idle", size = 64 }: { mood?: Mood; size?: number }) {
  const P = POSES[mood];
  const gl = Math.sqrt(P.gx * P.gx + P.gy * P.gy), gk = gl > 1 ? 1 / gl : 1, ox = P.gx * gk * 3.3, oy = P.gy * gk * 3.3;
  const mw = 9.2 * P.mw, mh = Math.max(0.8, P.mh), my = -26;
  const stroke = { stroke: PRUNE, strokeLinecap: "round" as const, fill: "none" };
  return (
    <svg viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`} width={size} height={Math.round((size * BOX.h) / BOX.w)} className={`cob-mascot ${MOOD_CLASS[mood]}`}
      aria-hidden focusable="false" data-mascot={mood} style={{ overflow: "visible" }}>
      <ellipse cx={0} cy={1.5} rx={29} ry={4.2} fill={PRUNE} fillOpacity={0.13} />
      <path d={arm(-1, P.lx, P.ly, P.lb)} {...stroke} strokeWidth={3.4} />
      <circle cx={P.lx} cy={P.ly} r={5.2} fill={PINK} stroke={PRUNE} strokeWidth={2.8} />
      <g className="cob-arm">
        <path d={arm(1, P.rx, P.ry, P.rb)} {...stroke} strokeWidth={3.4} />
        <circle cx={P.rx} cy={P.ry} r={5.2} fill={PINK} stroke={PRUNE} strokeWidth={2.8} />
      </g>
      <ellipse cx={-14} cy={-2} rx={9.5} ry={5.4} fill={PRUNE} />
      <ellipse cx={14} cy={-2} rx={9.5} ry={5.4} fill={PRUNE} />
      <path d={BODY} fill={PINK} stroke={PRUNE} strokeWidth={4.2} strokeLinejoin="round" />
      <ellipse cx={-17} cy={-54.5} rx={7} ry={3.2} transform="rotate(-22 -17 -54.5)" fill="#F7D2FC" />
      <path d={`M-18.5 ${f2(-52 + P.by)}L-6.5 ${f2(-53.5 + P.by - P.bt)}`} {...stroke} strokeWidth={4} />
      <path d={`M6.5 ${f2(-53.5 + P.by - P.bt)}L18.5 ${f2(-52 + P.by)}`} {...stroke} strokeWidth={4} />
      <g className="cob-eyes">
        {[-11.5, 11.5].map((x) => (
          <g key={x}>
            <circle cx={x} cy={-38} r={8.9} fill="#FFFFFF" stroke={PRUNE} strokeWidth={3} />
            <circle cx={f2(x + ox)} cy={f2(-38 + oy)} r={4.4} fill={PRUNE} />
            <circle cx={f2(x + ox - 1.4)} cy={f2(-39.6 + oy)} r={1.3} fill="#FFFFFF" />
          </g>
        ))}
      </g>
      <path d={`M${f2(-mw)} ${my}Q${f2(-mw * 0.95)} ${f2(my + mh * 1.15)} 0 ${f2(my + mh)}Q${f2(mw * 0.95)} ${f2(my + mh * 1.15)} ${f2(mw)} ${my}Z`}
        fill={PRUNE} stroke={PRUNE} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

const COLORS = ["#682dfe", "#8b5bff", "#E88BF7", "#1f9d5c", "#e9d7ff"];
/** Confettis (CSS), réservés à l'envoi final. `burst` change → nouvelle salve. Rien si l'utilisateur réduit les mouvements. */
export function Confetti({ burst }: { burst: number }) {
  const [pieces, setPieces] = useState<{ x: number; y: number; r: number; d: number; c: string }[]>([]);
  useEffect(() => {
    if (!burst) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const next = Array.from({ length: 14 }, (_, i) => ({
      x: Math.round(Math.cos((i / 14) * Math.PI * 2) * (60 + Math.random() * 90)),
      y: Math.round(Math.sin((i / 14) * Math.PI * 2) * (40 + Math.random() * 70) - 40),
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
    <span className={"cob-confetti"} aria-hidden key={burst}>
      {pieces.map((p, i) => (
        <i key={i} style={{ "--x": `${p.x}px`, "--y": `${p.y}px`, "--r": `${p.r}deg`, "--d": `${p.d}ms`, "--c": p.c } as React.CSSProperties} />
      ))}
    </span>
  );
}

/** Cély et ce qu'elle dit, sur une ligne discrète. `say` change → le texte réapparaît (annoncé aux lecteurs d'écran). */
export function Guide({ mood, say, burst, size = 56 }: { mood: Mood; say: string; burst: number; size?: number }) {
  return (
    <div className="flex items-center gap-3" data-guide>
      <span className="relative shrink-0">
        <Mascot mood={mood} size={size} key={mood} />
        <Confetti burst={burst} />
      </span>
      {say && <p key={say} role="status" aria-live="polite" className="cob-bubble max-w-md text-[15px] leading-snug text-muted">{say}</p>}
    </div>
  );
}
