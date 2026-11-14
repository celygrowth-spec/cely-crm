"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarDays, CheckSquare, FolderKanban, Columns3, LayoutGrid, Library, ListTodo, LogOut, Mail, MessagesSquare, PhoneCall, Plus, Search, Settings, Trash2, Trophy, Users, Wallet, X } from "lucide-react";
import type { LeadSource, List, PipelineWithStages } from "@/lib/crm/types";
import { signOutAction } from "@/app/actions";
import { QueryProvider, apiGet, useFlushRouterOnNavigate } from "@/lib/client/query";
import { cn } from "./ui";
import { SearchPalette } from "./search-palette";
import { CompanySheet } from "./company-sheet";
import { CreateCompanyModal, type CreateDefaults } from "./create-company";
import { TimerProvider } from "./time/timer";

/** Données déjà connues d'une fiche (ligne de tableau) : affichées dès l'ouverture. */
export type CompanySeed = { name: string; website?: string | null; domain_norm?: string | null };

type CrmContext = {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  openCompany: (id: string, seed?: CompanySeed) => void;
  prefetchCompany: (id: string) => void;
  openCreate: (defaults?: CreateDefaults) => void;
};

const Ctx = createContext<CrmContext | null>(null);

export function useCrm() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCrm hors du AppShell");
  return c;
}

export const PROSPECTION_NAV = [
  { href: "/prospection/reponses", label: "Réponses à traiter" },
  { href: "/prospection/campagnes", label: "Campagnes" },
  { href: "/prospection/base", label: "Base de prospects" },
  { href: "/prospection/listes", label: "Listes" },
  { href: "/prospection/modeles", label: "Modèles de séquence" },
  { href: "/prospection/doublons", label: "Doublons" },
  { href: "/prospection/import", label: "Import / export" },
];

export const FINANCE_NAV = [
  { href: "/finance", label: "Vue d'ensemble", exact: true },
  { href: "/finance/clients", label: "Revenus par client" },
  { href: "/finance/revenus", label: "Revenus" },
  { href: "/finance/charges", label: "Charges" },
  { href: "/finance/urssaf", label: "URSSAF" },
  { href: "/finance/rentabilite", label: "Rentabilité" },
  { href: "/finance/parametres", label: "Réglages Finance" },
];

export const RDV_NAV = [
  { href: "/rendez-vous", label: "Vue d'ensemble", exact: true },
  { href: "/rendez-vous/agenda", label: "Agenda" },
  { href: "/rendez-vous/types", label: "Types de rendez-vous" },
  { href: "/rendez-vous/disponibilites", label: "Disponibilités" },
];

export const PRODUCTIVITE_NAV = [
  { href: "/productivite/temps", label: "Temps" },
  { href: "/productivite/todo", label: "To do list" },
];

const NAV = [
  { href: "/", label: "Aujourd'hui", icon: CheckSquare },
  { href: "/prospection", label: "Prospection", icon: Users },
  { href: "/pipelines", label: "Pipelines", icon: Columns3 },
  { href: "/ventes", label: "Ventes", icon: Trophy },
  { href: "/projets", label: "Projets", icon: FolderKanban },
  { href: "/rendez-vous", label: "Rendez-vous", icon: CalendarDays },
  { href: "/finance", label: "Finance", icon: Wallet },
  { href: "/productivite", label: "Productivité", icon: ListTodo },
  { href: "/mail", label: "Mail", icon: Mail },
  { href: "/messages", label: "Messages", icon: MessagesSquare },
  { href: "/appels", label: "Appels", icon: PhoneCall },
  { href: "/bibliotheque", label: "Bibliothèque", icon: Library },
  { href: "/corbeille", label: "Corbeille", icon: Trash2 },
  { href: "/parametres", label: "Paramètres", icon: Settings },
];

// Barre du bas sur téléphone : cinq entrées fixes, le reste dans « Plus » (jamais de défilement horizontal)
const MOBILE_MAIN = ["/", "/prospection", "/pipelines", "/ventes", "/projets"];
const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));

export function AppShell(props: {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  children: ReactNode;
}) {
  return (
    <QueryProvider>
      <Suspense>
        <Shell {...props} />
      </Suspense>
    </QueryProvider>
  );
}

function Shell({
  sources,
  lists,
  pipelines,
  children,
}: {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  useFlushRouterOnNavigate();
  const { data: counters } = useQuery({
    queryKey: ["counters"],
    queryFn: ({ signal }) => apiGet<{ todo: number; due: number; replies: number; messages?: number }>("/api/counters", signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000, // non-lus de Messages (lemlist) : relus en arrière-plan, page visible
  });
  const todoCount = counters?.todo ?? 0;
  const dueCount = counters?.due ?? 0;
  const repliesCount = counters?.replies ?? 0;
  const messagesCount = counters?.messages ?? 0;
  const [searchOpen, setSearchOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);

  // Fiche ouverte par history.pushState : l'URL change sans aucun aller-retour serveur,
  // le tableau derrière reste affiché tel quel, avec ses filtres et son défilement.
  const openCompany = useCallback(
    (id: string, seed?: CompanySeed) => {
      if (seed) qc.setQueryData(["company-seed", id], seed);
      const sp = new URLSearchParams(window.location.search);
      sp.set("fiche", id);
      window.history.pushState(null, "", `${window.location.pathname}?${sp.toString()}`);
    },
    [qc],
  );
  const prefetchCompany = useCallback(
    (id: string) => {
      qc.prefetchQuery({ queryKey: ["company", id], queryFn: ({ signal }) => apiGet(`/api/fiches/${id}`, signal), staleTime: 30_000 });
    },
    [qc],
  );
  const closeCompany = useCallback(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete("fiche");
    const q = sp.toString();
    window.history.pushState(null, "", q ? `${window.location.pathname}?${q}` : window.location.pathname);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<CrmContext>(
    () => ({ sources, lists, pipelines, openCompany, prefetchCompany, openCreate: (d) => setCreateDefaults(d ?? {}) }),
    [sources, lists, pipelines, openCompany, prefetchCompany],
  );
  const ficheId = params.get("fiche");

  return (
    <Ctx.Provider value={value}>
      <TimerProvider>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <aside className="sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b border-line bg-white px-3 py-2 md:h-dvh md:w-60 md:overflow-y-auto md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-5">
          <Link href="/prospection" className="mr-2 shrink-0 md:mr-0 md:mb-6 md:px-2">
            <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={84} height={29} priority />
          </Link>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-sm text-muted hover:border-violet md:mb-2 md:flex-none"
          >
            <Search size={15} />
            <span className="flex-1 truncate">Rechercher…</span>
            <kbd className="hidden font-label text-[10px] md:inline">⌘K</kbd>
          </button>
          <button
            onClick={() => setCreateDefaults({})}
            className="flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-sm font-semibold text-white hover:bg-violet-strong md:mb-4"
            aria-label="Nouvelle fiche"
          >
            <Plus size={16} />
            <span className="hidden md:inline">Nouvelle fiche</span>
          </button>
          <nav className="hidden md:flex md:flex-col md:justify-start md:gap-0.5" aria-label="Navigation principale">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <div key={href}>
                  <Link
                    href={href}
                    className={cn(
                      "flex flex-row items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-semibold",
                      active ? "bg-violet-soft text-ink" : "text-muted hover:bg-surface hover:text-ink",
                    )}
                  >
                    <Icon size={17} className={active ? "text-violet-strong" : undefined} />
                    <span className="flex-1">{label}</span>
                    {href === "/" && todoCount > 0 && (
                      <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white">{todoCount}</span>
                    )}
                    {href === "/messages" && messagesCount > 0 && (
                      <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white" aria-label={`${messagesCount} non lu(s)`}>{messagesCount}</span>
                    )}
                  </Link>
                  {href === "/prospection" && active && (
                    <div className="mt-0.5 mb-1 ml-[22px] border-l border-line pl-2">
                      {PROSPECTION_NAV.map((n) => {
                        const on = pathname === n.href || pathname.startsWith(n.href + "/") || (n.href.endsWith("campagnes") && pathname.startsWith("/prospection/focus"));
                        return (
                          <Link
                            key={n.href}
                            href={n.href}
                            className={cn(
                              "flex items-center justify-between rounded-md px-2 py-1 text-[13px]",
                              on ? "font-semibold text-ink" : "text-muted hover:text-ink",
                            )}
                          >
                            {n.label}
                            {n.href.endsWith("reponses") && repliesCount > 0 && (
                              <span className="rounded-full bg-amber-100 px-1.5 font-label text-[10px] font-bold text-amber-800">{repliesCount}</span>
                            )}
                            {n.href.endsWith("campagnes") && dueCount > 0 && (
                              <span className="rounded-full bg-violet px-1.5 font-label text-[10px] font-bold text-white">{dueCount}</span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                  {href === "/rendez-vous" && active && (
                    <div className="mt-0.5 mb-1 ml-[22px] border-l border-line pl-2">
                      {RDV_NAV.map((n) => {
                        const on = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/");
                        return (
                          <Link
                            key={n.href}
                            href={n.href}
                            className={cn("flex items-center rounded-md px-2 py-1 text-[13px]", on ? "font-semibold text-ink" : "text-muted hover:text-ink")}
                          >
                            {n.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                  {(href === "/finance" || href === "/productivite") && active && (
                    <div className="mt-0.5 mb-1 ml-[22px] border-l border-line pl-2">
                      {(href === "/finance" ? FINANCE_NAV : PRODUCTIVITE_NAV).map((n: { href: string; label: string; exact?: boolean }) => {
                        const on = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/");
                        return (
                          <Link
                            key={n.href}
                            href={n.href}
                            className={cn("flex items-center rounded-md px-2 py-1 text-[13px]", on ? "font-semibold text-ink" : "text-muted hover:text-ink")}
                          >
                            {n.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <form action={signOutAction} onSubmit={() => qc.clear()} className="mt-auto hidden md:block">
            <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface hover:text-ink">
              <LogOut size={16} /> Déconnexion
            </button>
          </form>
        </aside>
        <MobileNav pathname={pathname} todoCount={todoCount} messagesCount={messagesCount} onSignOut={() => qc.clear()} />
        <main className="min-w-0 flex-1 px-4 pt-5 pb-36 md:px-8 md:pt-7 md:pb-24">{children}</main>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={(id) => { setSearchOpen(false); openCompany(id); }} onCreate={() => setCreateDefaults({})} />
      <CompanySheet id={ficheId} onClose={closeCompany} />
      <CreateCompanyModal
        defaults={createDefaults}
        onClose={() => setCreateDefaults(null)}
        onCreated={(id, name) => {
          setCreateDefaults(null);
          openCompany(id, { name });
        }}
      />
      </TimerProvider>
    </Ctx.Provider>
  );
}

/** Téléphone : cinq entrées en bas et « Plus », qui ouvre un panneau avec toutes les autres (dont Mail et Appels). */
function MobileNav({ pathname, todoCount, messagesCount, onSignOut }: { pathname: string; todoCount: number; messagesCount: number; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const main = NAV.filter((n) => MOBILE_MAIN.includes(n.href));
  const more = NAV.filter((n) => !MOBILE_MAIN.includes(n.href));
  const moreActive = more.some((n) => isActive(pathname, n.href));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const item = "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10.5px] font-semibold tracking-tight";
  return (
    <div className="md:hidden">
      {open && (
        <>
          <button type="button" aria-label="Fermer le menu" className="fixed inset-0 z-30 bg-ink/30" onClick={() => setOpen(false)} />
          <div id="menu-plus" role="dialog" aria-label="Autres rubriques" className="fade-in fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-line bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-display text-base font-bold text-ink">Autres rubriques</p>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Fermer"><X size={18} /></button>
            </div>
            <ul className="grid grid-cols-3 gap-2">
              {more.map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                return (
                  <li key={href}>
                    <Link href={href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
                      className={cn("flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-semibold", active ? "border-violet-line bg-violet-soft text-ink" : "border-line text-muted hover:text-ink")}>
                      <Icon size={19} className={active ? "text-violet-strong" : undefined} />
                      {label}
                      {href === "/messages" && messagesCount > 0 && <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white">{messagesCount} non lu(s)</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <form action={signOutAction} onSubmit={onSignOut} className="mt-3 border-t border-line pt-3">
              <button className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface hover:text-ink">
                <LogOut size={16} /> Déconnexion
              </button>
            </form>
          </div>
        </>
      )}
      <nav aria-label="Navigation principale" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white px-1 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)]">
        {main.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn(item, "relative", active ? "bg-violet-soft text-ink" : "text-muted")}>
              <Icon size={18} className={active ? "text-violet-strong" : undefined} />
              <span className="max-w-full truncate">{label}</span>
              {href === "/" && todoCount > 0 && (
                <span className="absolute top-0.5 right-[calc(50%-1.25rem)] rounded-full bg-violet px-1 font-label text-[9px] leading-tight text-white">{todoCount}</span>
              )}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="menu-plus"
          className={cn(item, "relative", moreActive || open ? "bg-violet-soft text-ink" : "text-muted")}>
          <LayoutGrid size={18} className={moreActive ? "text-violet-strong" : undefined} />
          {messagesCount > 0 && <span className="absolute top-1 right-[calc(50%-0.9rem)] size-2 rounded-full bg-violet" aria-label="Messages non lus" />}
          <span>Plus</span>
        </button>
      </nav>
    </div>
  );
}
