"use client";

// « Supprimer » sur la page d'un élément : après la mise à la corbeille, retour à la liste (la page de l'élément
// n'existe plus pour l'application).
import { useRouter } from "next/navigation";
import type { TrashKind } from "@/lib/trash/types";
import { TrashButton } from "./trash-button";

export function TrashAndLeave({ kind, id, href, label }: { kind: TrashKind; id: string; href: string; label: string }) {
  const router = useRouter();
  return <TrashButton kind={kind} id={id} variant="danger" onDone={() => router.push(href)}>{label}</TrashButton>;
}
