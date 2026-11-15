"use client";

// Accueil › À traiter : les appels Fireflies à rattacher, avec les mêmes actions que la page Appels (même requête,
// même cache) : un appel rattaché ou ignoré disparaît aussitôt, sans recharger.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CallCard } from "@/components/fireflies/call-list";
import { apiGet } from "@/lib/client/query";
import type { Call } from "@/lib/fireflies/types";
import { LinkActions } from "../appels/to-link-view";

const SHOWN = 3;

export function HomeCalls({ initial }: { initial: number }) {
  const router = useRouter();
  const [hadCalls] = useState(initial > 0); // figé au premier affichage : le rafraîchissement après un rattachement ne masque pas le message
  const q = useQuery({
    queryKey: ["fireflies-to-link", "to_link"],
    queryFn: ({ signal }) => apiGet<Call[]>("/api/fireflies/to-link?state=to_link", signal),
  });
  const list = q.data ?? [];
  if (!hadCalls || q.isLoading) return null;
  if (q.isError) return <p className="text-sm text-danger">{q.error.message}</p>;
  if (!list.length) return <p className="text-sm text-muted" data-home-calls-done>Tous les appels sont rattachés.</p>;
  return (
    <section data-home-calls aria-label="Appels à rattacher">
      <h3 className="mb-1.5 flex items-baseline justify-between font-label text-xs font-bold text-muted uppercase">
        <span>Appels à rattacher · {list.length}</span>
        {list.length > SHOWN && <Link href="/appels" className="normal-case text-violet-strong hover:underline">Tout voir →</Link>}
      </h3>
      <ul className="space-y-2">
        {list.slice(0, SHOWN).map((c) => (
          <CallCard key={c.id} call={c} onOpen={() => router.push("/appels")}>
            <LinkActions call={c} ignored={false} />
          </CallCard>
        ))}
      </ul>
    </section>
  );
}
