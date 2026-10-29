"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckSquare, Columns3, LogOut, Plus, Search, Settings, Users } from "lucide-react";
import type { LeadSource, List, PipelineWithStages } from "@/lib/crm/types";
import { signOutAction } from "@/app/actions";
import { cn } from "./ui";
import { SearchPalette } from "./search-palette";
import { CompanySheet } from "./company-sheet";
import { CreateCompanyModal, type CreateDefaults } from "./create-company";

type CrmContext = {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  openCompany: (id: string) => void;
  openCreate: (defaults?: CreateDefaults) => void;
};

const Ctx = createContext<CrmContext | null>(null);

export function useCrm() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCrm hors du AppShell");
  return c;
}

const NAV = [
  { href: "/prospection", label: "Prospection", icon: Users },
  { href: "/pipelines", label: "Pipelines", icon: Columns3 },
  { href: "/a-faire", label: "À faire", icon: CheckSquare },
  { href: "/parametres", label: "Paramètres", icon: Settings },
];

export function AppShell(props: {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  todoCount: number;
  children: ReactNode;
}) {
  return (
    <Suspense>
      <Shell {...props} />
    </Suspense>
  );
}

function Shell({
  sources,
  lists,
  pipelines,
  todoCount,
  children,
}: {
  sources: LeadSource[];
  lists: List[];
  pipelines: PipelineWithStages[];
  todoCount: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);

  const openCompany = useCallback(
    (id: string) => {
      const sp = new URLSearchParams(params.toString());
      sp.set("fiche", id);
      router.push(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const closeCompany = useCallback(() => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("fiche");
    const q = sp.toString();
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [params, pathname, router]);

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
    () => ({ sources, lists, pipelines, openCompany, openCreate: (d) => setCreateDefaults(d ?? {}) }),
    [sources, lists, pipelines, openCompany],
  );
  const ficheId = params.get("fiche");

  return (
    <Ctx.Provider value={value}>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <aside className="sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b border-line bg-white px-3 py-2 md:h-dvh md:w-56 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-5">
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
          <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-white py-1 md:static md:flex-col md:justify-start md:gap-0.5 md:border-0 md:py-0">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold md:flex-row md:gap-2.5 md:py-2 md:text-sm",
                    active ? "bg-violet-soft text-ink" : "text-muted hover:bg-surface hover:text-ink",
                  )}
                >
                  <Icon size={17} className={active ? "text-violet-strong" : undefined} />
                  <span className="flex-1">{label}</span>
                  {href === "/a-faire" && todoCount > 0 && (
                    <span className="hidden rounded-full bg-violet px-1.5 font-label text-[10px] text-white md:inline">{todoCount}</span>
                  )}
                </Link>
              );
            })}
          </nav>
          <form action={signOutAction} className="mt-auto hidden md:block">
            <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface hover:text-ink">
              <LogOut size={16} /> Déconnexion
            </button>
          </form>
        </aside>
        <main className="min-w-0 flex-1 px-4 pt-5 pb-24 md:px-8 md:pt-7 md:pb-10">{children}</main>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={(id) => { setSearchOpen(false); openCompany(id); }} />
      {ficheId && <CompanySheet id={ficheId} onClose={closeCompany} />}
      <CreateCompanyModal
        defaults={createDefaults}
        onClose={() => setCreateDefaults(null)}
        onCreated={(id) => {
          setCreateDefaults(null);
          openCompany(id);
        }}
      />
    </Ctx.Provider>
  );
}
