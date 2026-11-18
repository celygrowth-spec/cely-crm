"use client";

// Accueil › Prochaines actions clients : les actions du parcours (diagnostic, proposition, signature, onboarding)
// qui attendent quelque chose de moi, datées. À l'ouverture, une signature reçue de Make en mon absence fait passer
// la fiche en client (logique existante, une seule fois).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFinalizeSignatures } from "@/components/record-proposal";
import { relativeDay } from "@/lib/format";
import type { TodoLine } from "@/lib/journey/rules";

export function JourneyActions({ lines }: { lines: TodoLine[] }) {
  const router = useRouter();
  useFinalizeSignatures(() => router.refresh());
  if (!lines.length) return <p className="text-sm text-muted" data-empty>Aucune action en attente sur vos diagnostics, propositions et onboardings.</p>;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line" data-home-journey>
      {lines.slice(0, 8).map((l) => (
        <li key={`${l.company_id}:${l.step}`}>
          <Link href={l.href} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-violet-soft/30" data-journey-step={l.step}>
            <span className="min-w-0 flex-1 truncate font-semibold">{l.title}</span>
            <span className="hidden shrink-0 text-xs text-muted sm:inline">{relativeDay(l.since.slice(0, 10))}</span>
            <span className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-violet-strong">{l.label}</span>
          </Link>
        </li>
      ))}
      {lines.length > 8 && <li className="px-3 py-2 text-xs text-muted">Et {lines.length - 8} autre(s), visibles sur leur fiche et dans Pipelines.</li>}
    </ul>
  );
}
