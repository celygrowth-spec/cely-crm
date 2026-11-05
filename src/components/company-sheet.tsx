"use client";

import { useEffect, useRef, useState } from "react";
import { CompanyRecord } from "./company-record";

/** Panneau latéral de la fiche. L'URL se met à jour tout de suite ; la sortie n'est qu'un effet visuel. */
export function CompanySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [shown, setShown] = useState(id);
  const [prevId, setPrevId] = useState(id);
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  if (id !== prevId) {
    setPrevId(id);
    if (id) setShown(id); // ouverture ou changement de fiche immédiats
  }
  const closing = !id && !!shown;

  useEffect(() => {
    if (id) {
      opener.current = document.activeElement;
      panelRef.current?.focus();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
    }
  }, [id]);

  // filet de sécurité : sans image rendue (onglet masqué), l'animation ne se termine pas et le voile bloquerait l'écran
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setShown(null), 300);
    return () => clearTimeout(t);
  }, [closing]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  if (!shown) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button className={`absolute inset-0 bg-ink/25 ${closing ? "shade-out" : "shade-in"}`} aria-label="Fermer la fiche" onClick={onClose} tabIndex={-1} />
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onAnimationEnd={() => closing && setShown(null)}
        className={`relative h-full w-full max-w-3xl overflow-y-auto border-l border-line bg-white shadow-2xl outline-none ${closing ? "sheet-out" : "sheet-in"}`}
      >
        <CompanyRecord key={shown} id={shown} onClose={onClose} />
      </section>
    </div>
  );
}
