"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderKanban, Home, LayoutGrid, LogOut, Search, Settings, Users, Wallet, X } from "lucide-react";
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

// Navigation en six entrées. Chaque écran existant reste accessible : les sous-pages des espaces (Prospection,
// Finance, Agenda, Productivité) sont dans les onglets de leur page.
export type NavItem = { href: string; label: string; match?: string[]; exact?: boolean };
export type NavSection = { key: string; label: string; icon: typeof Users; href?: string; items?: NavItem[] };
export const NAV: NavSection[] = [
  { key: "accueil", label: "Accueil", icon: Home, href: "/" },
  { key: "commerce", label: "Commerce", icon: Users, items: [
    { href: "/prospection/campagnes", label: "Prospection", match: ["/prospection"] },
    { href: "/ventes", label: "Ventes" },
    { href: "/pipelines", label: "Pipelines" },
    { href: "/fiches", label: "Fiches", exact: true },
  ] },
  { key: "clients", label: "Clients", icon: FolderKanban, items: [
    { href: "/projets", label: "Projets" },
    { href: "/messages", label: "Messages" },
    { href: "/clients/portail", label: "Portail client" },
  ] },
  { key: "finance", label: "Finance", icon: Wallet, items: [
    { href: "/finance/revenus", label: "Revenus", match: ["/finance"] },
    { href: "/finance/revenus?vue=factures", label: "Factures" },
    { href: "/finance/revenus?vue=paiements", label: "Règlements" },
  ] },
  { key: "autres", label: "Autres", icon: LayoutGrid, items: [
    { href: "/rendez-vous/agenda", label: "Agenda", match: ["/rendez-vous"] },
    { href: "/mail", label: "Mail" },
    { href: "/appels", label: "Appels" },
    { href: "/productivite/temps", label: "Suivi du temps", match: ["/temps"] },
    { href: "/productivite/todo", label: "To do list" },
    { href: "/bibliotheque", label: "Bibliothèque" },
  ] },
  { key: "parametres", label: "Paramètres", icon: Settings, items: [
    { href: "/parametres/connecteurs", label: "Connecteurs" },
    { href: "/parametres", label: "Réglages", exact: true, match: ["/parametres/diagnostic"] },
    { href: "/parametres/passages", label: "Passages planifiés" },
    { href: "/corbeille", label: "Corbeille" },
  ] },
];

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(base + "/");
/** Entrée active : l'adresse (sans requête) ou une rubrique rattachée. Les entrées à requête (?vue=) comparent aussi la requête. */
export function isItemActive(pathname: string, search: string, it: NavItem): boolean {
  const [path, query] = it.href.split("?");
  if (query) return pathname === path && new URLSearchParams(search).get("vue") === new URLSearchParams(query).get("vue");
  if (it.href === "/finance/revenus") {
    const vue = new URLSearchParams(search).get("vue");
    if (pathname === "/finance/revenus" && (vue === "factures" || vue === "paiements")) return false;
    return under(pathname, "/finance");
  }
  if (it.exact) return pathname === path || (it.match ?? []).some((m) => under(pathname, m));
  return under(pathname, path) || (it.match ?? []).some((m) => under(pathname, m));
}
export function sectionActive(pathname: string, search: string, s: NavSection): boolean {
  if (s.href) return s.href === "/" ? pathname === "/" : under(pathname, s.href);
  return (s.items ?? []).some((it) => isItemActive(pathname, search, it)) || (s.key === "commerce" && under(pathname, "/fiches"));
}

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
  // pastille d'Accueil : ce qui demande une action (même règle que le bloc « À traiter »)
  const homeCount = counters?.todo ?? 0;
  const search = params.toString();
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
    [sources, lists, pipelines, openCompany, prefetchCompany, setCreateDefaults],
  );
  const ficheId = params.get("fiche");

  return (
    <Ctx.Provider value={value}>
      <TimerProvider>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <aside className="sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b border-line bg-white px-3 py-2 md:h-dvh md:w-60 md:overflow-y-auto md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-5">
          <Link href="/" className="mr-2 shrink-0 md:mr-0 md:mb-6 md:px-2">
            <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={84} height={29} priority />
          </Link>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-sm text-muted hover:border-violet md:mb-4 md:flex-none"
          >
            <Search size={15} />
            <span className="flex-1 truncate">Rechercher…</span>
            <kbd className="hidden font-label text-[10px] md:inline">⌘K</kbd>
          </button>
          <nav className="hidden md:flex md:flex-col md:justify-start md:gap-2" aria-label="Navigation principale" data-nav>
            {NAV.map((sec) => {
              const Icon = sec.icon;
              const on = sectionActive(pathname, search, sec);
              if (sec.href) {
                return (
                  <Link key={sec.key} href={sec.href} aria-current={on ? "page" : undefined}
                    className={cn("flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-semibold", on ? "bg-violet-soft text-ink" : "text-muted hover:bg-surface hover:text-ink")}>
                    <Icon size={17} className={on ? "text-violet-strong" : undefined} />
                    <span className="flex-1">{sec.label}</span>
                    {homeCount > 0 && <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white">{homeCount}</span>}
                  </Link>
                );
              }
              return (
                <div key={sec.key} data-nav-section={sec.key}>
                  <p className={cn("flex items-center gap-2.5 px-3 py-1 font-label text-[11px] font-bold tracking-wide uppercase", on ? "text-ink" : "text-muted")}>
                    <Icon size={15} className={on ? "text-violet-strong" : undefined} /> {sec.label}
                  </p>
                  <div className="ml-[22px] border-l border-line pl-2">
                    {sec.items!.map((it) => {
                      const active = isItemActive(pathname, search, it);
                      return (
                        <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}
                          className={cn("flex items-center justify-between rounded-md px-2 py-1 text-[13px]", active ? "bg-violet-soft font-semibold text-ink" : "text-muted hover:text-ink")}>
                          {it.label}
                          {it.label === "Messages" && messagesCount > 0 && (
                            <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white" aria-label={`${messagesCount} non lu(s)`}>{messagesCount}</span>
                          )}
                          {it.label === "Prospection" && repliesCount > 0 && (
                            <span className="rounded-full bg-amber-100 px-1.5 font-label text-[10px] font-bold text-amber-800" aria-label={`${repliesCount} réponse(s) à traiter`}>{repliesCount}</span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
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
        <MobileNav pathname={pathname} search={search} homeCount={homeCount} messagesCount={messagesCount} onSignOut={() => qc.clear()} />
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

/** Téléphone : les mêmes six entrées en bas ; une rubrique ouvre un panneau avec ses écrans. */
function MobileNav({ pathname, search, homeCount, messagesCount, onSignOut }: { pathname: string; search: string; homeCount: number; messagesCount: number; onSignOut: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const sec = NAV.find((s) => s.key === open) ?? null;
  const item = "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10.5px] font-semibold tracking-tight";
  return (
    <div className="md:hidden">
      {sec && (
        <>
          <button type="button" aria-label="Fermer le menu" className="fixed inset-0 z-30 bg-ink/30" onClick={() => setOpen(null)} />
          <div id="menu-rubrique" role="dialog" aria-label={sec.label} className="fade-in fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-line bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-display text-base font-bold text-ink">{sec.label}</p>
              <button type="button" onClick={() => setOpen(null)} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Fermer"><X size={18} /></button>
            </div>
            <ul className="grid grid-cols-2 gap-2">
              {sec.items!.map((it) => {
                const active = isItemActive(pathname, search, it);
                return (
                  <li key={it.href}>
                    <Link href={it.href} onClick={() => setOpen(null)} aria-current={active ? "page" : undefined}
                      className={cn("flex items-center justify-between rounded-xl border px-3 py-3 text-sm font-semibold", active ? "border-violet-line bg-violet-soft text-ink" : "border-line text-muted hover:text-ink")}>
                      {it.label}
                      {it.label === "Messages" && messagesCount > 0 && <span className="rounded-full bg-violet px-1.5 font-label text-[10px] text-white">{messagesCount}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {sec.key === "parametres" && (
              <form action={signOutAction} onSubmit={onSignOut} className="mt-3 border-t border-line pt-3">
                <button className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface hover:text-ink">
                  <LogOut size={16} /> Déconnexion
                </button>
              </form>
            )}
          </div>
        </>
      )}
      <nav aria-label="Navigation principale" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white px-1 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)]">
        {NAV.map((s) => {
          const Icon = s.icon;
          const active = sectionActive(pathname, search, s) || open === s.key;
          const badge = s.key === "accueil" ? homeCount : s.key === "clients" ? messagesCount : 0;
          const inner = (
            <>
              <Icon size={18} className={active ? "text-violet-strong" : undefined} />
              <span className="max-w-full truncate">{s.label}</span>
              {badge > 0 && <span className="absolute top-0.5 right-[calc(50%-1.25rem)] rounded-full bg-violet px-1 font-label text-[9px] leading-tight text-white">{badge}</span>}
            </>
          );
          return s.href ? (
            <Link key={s.key} href={s.href} aria-current={active ? "page" : undefined} className={cn(item, "relative", active ? "bg-violet-soft text-ink" : "text-muted")}>{inner}</Link>
          ) : (
            <button key={s.key} type="button" onClick={() => setOpen(open === s.key ? null : s.key)} aria-expanded={open === s.key} aria-controls="menu-rubrique"
              className={cn(item, "relative", active ? "bg-violet-soft text-ink" : "text-muted")}>{inner}</button>
          );
        })}
      </nav>
    </div>
  );
}
