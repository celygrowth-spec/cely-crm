"use client";

// Publication : Publier maintenant, Programmer (heure de Paris), Dépublier, Repasser en brouillon.
// Un double clic ne publie qu'une fois (bouton bloqué pendant l'appel, et la base renvoie « déjà publié »).
// Une date passée demande confirmation d'une publication immédiate.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { publishNowAction, scheduleAction, setStatusAction, type CmsResult } from "@/app/cms-actions";
import { Button, Card, Input, Modal } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis, fromParisInput, toParisInput } from "@/lib/cms/dates";
import { effectiveStatus, type CmsEntry } from "@/lib/cms/types";

export function PublishPanel({ entry, dirty, save }: { entry: CmsEntry; dirty: boolean; save: () => Promise<boolean> }) {
  const router = useRouter();
  const status = effectiveStatus(entry);
  const [at, setAt] = useState(toParisInput(entry.status === "scheduled" ? entry.publish_at : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPast, setConfirmPast] = useState<string | null>(null);

  async function run(fn: () => Promise<CmsResult<CmsEntry>>, done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (dirty && !(await save())) return;
      const r = await attempt(fn);
      if (!r.ok) {
        if ("code" in r && r.code === "past_date") return setConfirmPast(fromParisInput(at));
        return setError(r.error);
      }
      toast.success(done);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const iso = fromParisInput(at);
  return (
    <Card className="space-y-3 p-4" data-cms-publish>
      <h2 className="font-display text-base font-bold">Publication</h2>
      <p className="text-sm text-muted" data-publish-state>
        {status === "published" && <>En ligne depuis le {formatParis(entry.publish_at)}.</>}
        {status === "scheduled" && <>Programmé pour le {formatParis(entry.publish_at)} (heure de Paris).</>}
        {status === "draft" && <>Brouillon : invisible sur le site.</>}
        {status === "unpublished" && <>Dépublié : retiré du site et du sitemap.</>}
      </p>
      {status !== "published" && (
        <Button variant="primary" className="w-full" disabled={busy} onClick={() => run(() => publishNowAction(entry.id), "Article publié")} data-publish-now>
          Publier maintenant
        </Button>
      )}
      <div className="space-y-1.5">
        <label className="font-label text-xs font-semibold text-muted" htmlFor="cms-at">Date et heure de publication (Paris)</label>
        <Input id="cms-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} data-publish-at />
        <Button className="w-full" disabled={busy || !iso} onClick={() => iso && run(() => scheduleAction(entry.id, iso), "Publication programmée")} data-schedule>
          {status === "scheduled" ? "Modifier la programmation" : "Programmer"}
        </Button>
      </div>
      {(status === "published" || status === "scheduled") && (
        <Button variant="danger" className="w-full" disabled={busy} onClick={() => run(() => setStatusAction(entry.id, "unpublished"), "Article dépublié")} data-unpublish>
          Dépublier
        </Button>
      )}
      {(status === "scheduled" || status === "unpublished") && (
        <Button variant="ghost" className="w-full" disabled={busy} onClick={() => run(() => setStatusAction(entry.id, "draft"), "Article repassé en brouillon")} data-to-draft>
          Repasser en brouillon
        </Button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Modal open={!!confirmPast} onClose={() => setConfirmPast(null)} title="Date déjà passée">
        <p className="text-sm">La date choisie ({formatParis(confirmPast)}) est déjà passée. Publier l&apos;article immédiatement ?</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmPast(null)}>Annuler</Button>
          <Button variant="primary" disabled={busy} data-confirm-now onClick={() => {
            const when = confirmPast!;
            setConfirmPast(null);
            void run(() => scheduleAction(entry.id, when, true), "Article publié");
          }}>Publier maintenant</Button>
        </div>
      </Modal>
    </Card>
  );
}
