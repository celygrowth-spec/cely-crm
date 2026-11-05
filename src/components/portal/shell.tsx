"use client";

// Barre et navigation du portail : quatre entrées au plus, aucune donnée interne.
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { FolderOpen, Home, Lightbulb, ListChecks, LogOut } from "lucide-react";
import { cn } from "@/components/ui";
import type { PortalMe } from "@/lib/projects/types";

export function PortalTopBar({ me, projectId }: { me: PortalMe; projectId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <Link href="/portail" aria-label="Accueil de l'espace client"><Image src="/brand/cely-logo.svg" alt="Cely Growth" width={70} height={24} priority /></Link>
        {projectId && me.projects.length > 1 && (
          <select
            aria-label="Changer de projet"
            value={projectId}
            onChange={(e) => router.push(`/portail/p/${e.target.value}`)}
            className="h-8 max-w-48 truncate rounded-lg border border-line bg-white px-2 text-sm font-semibold text-ink"
          >
            {me.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="ml-auto hidden text-sm text-muted sm:inline">{me.person.first_name} {me.person.last_name} · {me.person.company}</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await fetch("/api/portail/deconnexion", { method: "POST" }).catch(() => undefined);
            router.replace("/portail");
            router.refresh();
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-surface hover:text-ink"
        >
          <LogOut size={15} aria-hidden /> <span className="hidden sm:inline">Déconnexion</span>
        </button>
      </div>
    </header>
  );
}

export function PortalNav({ projectId, sections }: { projectId: string; sections: ("taches" | "fichiers" | "idees")[] }) {
  const pathname = usePathname();
  const base = `/portail/p/${projectId}`;
  const items = [
    { href: base, label: "Vue d'ensemble", icon: Home, exact: true },
    ...(sections.includes("taches") ? [{ href: `${base}/taches`, label: "Mes tâches", icon: ListChecks, exact: false }] : []),
    ...(sections.includes("fichiers") ? [{ href: `${base}/fichiers`, label: "Fichiers", icon: FolderOpen, exact: false }] : []),
    ...(sections.includes("idees") ? [{ href: `${base}/idees`, label: "Boîte à idées", icon: Lightbulb, exact: false }] : []),
  ];
  if (items.length < 2) return null;
  return (
    <nav aria-label="Sections du projet" className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white md:static md:mb-6 md:border-0 md:bg-transparent">
      <ul className="mx-auto flex max-w-5xl justify-around md:justify-start md:gap-1">
        {items.map(({ href, label, icon: Icon, exact }) => {
          const on = exact ? pathname === href : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-2 text-[11px] font-semibold md:flex-row md:gap-2 md:rounded-lg md:text-sm",
                  on ? "text-violet-strong md:bg-white md:text-ink md:shadow-sm" : "text-muted hover:text-ink",
                )}
              >
                <Icon size={17} aria-hidden /> {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
