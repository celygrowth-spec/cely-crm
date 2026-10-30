"use client";

import { useEffect } from "react";
import { CompanyRecord } from "./company-record";

/** Panneau latéral large affichant la fiche (même composant que la page dédiée). */
export function CompanySheet({ id, onClose }: { id: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button className="absolute inset-0 bg-ink/25" aria-label="Fermer la fiche" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        className="relative h-full w-full max-w-3xl overflow-y-auto border-l border-line bg-white shadow-2xl"
      >
        <CompanyRecord key={id} id={id} onClose={onClose} />
      </section>
    </div>
  );
}
