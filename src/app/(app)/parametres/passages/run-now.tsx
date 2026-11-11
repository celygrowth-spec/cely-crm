"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";

/** Lance tous les passages tout de suite (session du propriétaire). */
export function RunNow() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const res = await fetch("/api/cron", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return toast.error("Le passage n'a pas pu être lancé.");
    toast.success("Passage effectué");
    router.refresh();
  }
  return <Button onClick={go} disabled={busy}>{busy ? "En cours…" : "Lancer maintenant"}</Button>;
}
