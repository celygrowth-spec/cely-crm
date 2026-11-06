"use client";

// Mascotte Cely Growth, posée près de la phase en cours. Elle « arrive » au chargement et fait un petit
// saut de joie quand une étape vient d'être terminée (depuis la dernière visite sur cet appareil).
// Petite (28 px), décorative (aria-hidden), elle ne masque ni dates ni libellés ; animations coupées si
// l'utilisateur préfère réduire les mouvements.
//
// Visuel : aucun fichier de la mascotte n'existe aujourd'hui dans le dépôt. Déposer le fichier d'origine
// (SVG ou PNG transparent, carré) dans public/brand/ et renseigner MASCOT_SRC pour l'activer.
import { useEffect, useState } from "react";

export const MASCOT_SRC: string | null = null; // ex. "/brand/mascotte.svg"

export function Mascot({ projectId, phase, done, src = MASCOT_SRC }: { projectId: string; phase: string; done: number; src?: string | null }) {
  const [cheer, setCheer] = useState(false);
  useEffect(() => {
    const key = `cely-portal-done:${projectId}`;
    try {
      const seen = Number(window.localStorage.getItem(key) ?? "NaN");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // première visite : on mémorise sans fêter ; ensuite, une étape terminée de plus → saut
      if (!Number.isNaN(seen) && done > seen && !reduce) {
        const t = window.setTimeout(() => setCheer(true), 450);
        window.localStorage.setItem(key, String(done));
        return () => window.clearTimeout(t);
      }
      window.localStorage.setItem(key, String(done));
    } catch {
      /* stockage indisponible (navigation privée) : pas d'animation de fête, rien d'autre ne change */
    }
  }, [projectId, done]);
  if (!src) return null;
  return (
    <span className={cheer ? "mascot-cheer inline-block" : "mascot-enter inline-block"} title={`Phase en cours : ${phase}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- petit visuel statique de marque */}
      <img src={src} alt="" width={28} height={28} className="block size-7 select-none" draggable={false} />
    </span>
  );
}
