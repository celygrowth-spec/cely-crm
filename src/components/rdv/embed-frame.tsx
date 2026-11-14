"use client";

// Cadre de la page de réservation affichée dans un autre site.
// Ne transmet au site hôte que des informations techniques (prêt, hauteur, changement d'étape) :
// aucune donnée saisie par le visiteur, aucun identifiant de rendez-vous.
import { useEffect, useRef } from "react";

const isEmbedded = () => typeof window !== "undefined" && window.parent !== window;

/** Message au script d'intégration. Contenu non sensible : il peut être lu par n'importe quel site hôte. */
export function notifyHost(type: "ready" | "resize" | "step" | "close", extra?: { height: number }) {
  if (!isEmbedded()) return;
  try {
    window.parent.postMessage({ celyRdv: 1, type, ...extra }, "*");
  } catch {
    /* site hôte inaccessible : sans conséquence */
  }
}

export function EmbedFrame({ mode, children }: { mode: "inline" | "popup"; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let last = 0;
    const send = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h !== last) {
        last = h;
        notifyHost("resize", { height: h });
      }
    };
    const ro = new ResizeObserver(send);
    ro.observe(el);
    send();
    notifyHost("ready");

    // les liens (gérer le rendez-vous, agenda, visio) s'ouvrent dans un nouvel onglet :
    // les autres pages du CRM refusent de s'afficher dans un autre site
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && !a.target && !a.hasAttribute("download")) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    };
    document.addEventListener("click", onClick, true);
    // Échap dans la fenêtre par-dessus le site : la ferme, comme un clic sur la croix
    const onKey = (e: KeyboardEvent) => {
      if (mode === "popup" && e.key === "Escape") notifyHost("close");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      ro.disconnect();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [mode]);

  return (
    <div ref={root} data-embed={mode} className="p-1">
      {/* fond transparent : le site hôte reste visible autour de la carte */}
      <style>{"html,body{background:transparent}"}</style>
      {children}
    </div>
  );
}
