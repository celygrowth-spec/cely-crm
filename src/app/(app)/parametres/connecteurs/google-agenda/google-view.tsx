"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { disconnectGoogleAction, refreshGoogleCalendarsAction, retryCalendarSyncAction, setGoogleCalendarsAction } from "@/app/rendez-vous-actions";
import { Badge, Button, Card } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import type { GoogleConnection } from "@/lib/appointments/types";

export function GoogleView({ connection: c, config, outOfSync, error, justConnected }: {
  connection: GoogleConnection | null; config: { secret: boolean; google: boolean }; outOfSync: number; error: string | null; justConnected: boolean;
}) {
  const sync = useSync();
  const [check, setCheck] = useState<string[]>(c?.check_calendar_ids ?? []);
  const [dest, setDest] = useState<string | null>(c?.destination_calendar_id ?? null);
  const [busy, setBusy] = useState(false);
  const dirty = c && (JSON.stringify([...check].sort()) !== JSON.stringify([...c.check_calendar_ids].sort()) || dest !== c.destination_calendar_id);

  async function disconnect() {
    setBusy(true);
    const r = await attempt(disconnectGoogleAction);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.revoked) toast.success("Agenda déconnecté, accès révoqué chez Google. Réservation en ligne suspendue.");
    else toast.warning("Agenda déconnecté, mais Google n'a pas confirmé la révocation : retirez l'accès depuis votre compte Google (Sécurité › Applications tierces). Réservation en ligne suspendue.");
    sync();
  }

  async function act<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, msg: string) {
    setBusy(true);
    const r = await attempt(fn);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    sync();
  }

  return (
    <div className="max-w-3xl space-y-4">
      {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{error}</p>}
      {justConnected && <p role="status" className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 size={16} /> Agenda Google connecté. Vérifiez les agendas ci-dessous.</p>}

      {(!config.google || !config.secret) && (
        <Card className="space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-ink">
          <p className="font-semibold text-warning">Configuration serveur incomplète</p>
          <ul className="list-disc pl-5 text-muted">
            {!config.secret && <li><code>APPOINTMENTS_SECRET</code> absent : réservation publique et connexion désactivées.</li>}
            {!config.google && <li><code>GOOGLE_CALENDAR_CLIENT_ID</code> / <code>GOOGLE_CALENDAR_CLIENT_SECRET</code> absents : connexion Google impossible.</li>}
          </ul>
          <p className="text-muted">Étapes détaillées : <code>docs/integrations/google-calendar.md</code>. Sans agenda connecté, les créneaux reposent uniquement sur vos disponibilités et vos rendez-vous enregistrés ici.</p>
        </Card>
      )}

      {!c ? (
        <Card className="space-y-3 p-5">
          <h2 className="font-display text-lg font-bold text-ink">Aucun agenda connecté</h2>
          <p className="text-sm text-muted">La connexion demande uniquement :</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>la liste de vos agendas (pour choisir ceux à vérifier et celui qui reçoit les rendez-vous) ;</li>
            <li>vos plages occupées (jamais le contenu de vos événements) ;</li>
            <li>la création, modification et suppression des événements des rendez-vous, sur vos propres agendas.</li>
          </ul>
          <p className="text-xs text-muted">Gmail n&apos;est pas concerné : sa connexion relève du module Mail et reste indépendante.</p>
          {config.google && config.secret ? (
            <a href="/api/rendez-vous/google/connect" className="inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-violet-strong">Connecter Google Agenda</a>
          ) : <Button disabled>Connecter Google Agenda</Button>}
        </Card>
      ) : (
        <>
          <Card className="space-y-2 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold text-ink">{c.google_email ?? "Compte Google"}</h2>
              <Badge tone={c.status === "connected" ? "success" : "danger"}>{c.status === "connected" ? "Connecté" : "Erreur"}</Badge>
            </div>
            <p className="text-xs text-muted">Connecté le {formatDateTime(c.connected_at)}</p>
            {c.status === "error" && (
              <p className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
                {c.last_error ?? "Erreur inconnue"}. Tant que l&apos;agenda ne répond pas, la page publique ne propose aucun créneau (rien n&apos;est considéré libre sans vérification).
                <a href="/api/rendez-vous/google/connect" className="ml-1 font-semibold underline">Reconnecter</a>
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" disabled={busy} onClick={() => act(refreshGoogleCalendarsAction, "Agendas actualisés")}><RefreshCw size={13} /> Actualiser la liste</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => confirm("Déconnecter Google Agenda ?\n\nLa page de réservation publique sera suspendue (disponibilités invérifiables), les reports en ligne aussi. Les événements déjà créés restent dans Google ; une annulation sera répercutée à la reconnexion.") && void disconnect()}>Déconnecter</Button>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-display text-base font-bold text-ink">Agendas</h3>
            <p className="mb-3 text-xs text-muted">Cochez les agendas dont les occupations bloquent des créneaux, et choisissez celui qui reçoit les rendez-vous.</p>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-semibold">Agenda</th><th className="w-28 py-1 text-center font-semibold">Vérifier</th><th className="w-28 py-1 text-center font-semibold">Destination</th></tr></thead>
              <tbody className="divide-y divide-line">
                {c.calendars.map((cal) => {
                  const writable = cal.accessRole === "owner";
                  return (
                    <tr key={cal.id}>
                      <td className="py-2">
                        <span className="mr-2 inline-block size-2.5 rounded-full align-middle" style={{ background: cal.backgroundColor ?? "#8b5bff" }} aria-hidden />
                        {cal.summary}{cal.primary && <span className="ml-1 text-xs text-muted">(principal)</span>}
                      </td>
                      <td className="text-center"><input type="checkbox" aria-label={`Vérifier ${cal.summary}`} checked={check.includes(cal.id)} onChange={(e) => setCheck(e.target.checked ? [...check, cal.id] : check.filter((x) => x !== cal.id))} /></td>
                      <td className="text-center">
                        <input type="radio" name="dest" aria-label={`Destination ${cal.summary}`} disabled={!writable} title={writable ? undefined : "Seuls vos propres agendas peuvent recevoir les rendez-vous"} checked={dest === cal.id} onChange={() => setDest(cal.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted"><input type="radio" name="dest" checked={dest === null} onChange={() => setDest(null)} /> Ne pas créer d&apos;événement Google</label>
            {dirty && <Button className="mt-3" variant="primary" disabled={busy} onClick={() => act(() => setGoogleCalendarsAction(check, dest), "Choix enregistrés")}>Enregistrer</Button>}
          </Card>
        </>
      )}

      <Card className="space-y-2 p-5 text-sm">
        <h3 className="font-display text-base font-bold text-ink">Synchronisation</h3>
        <p className="text-muted">
          {outOfSync === 0 ? "Tous les rendez-vous sont à jour dans Google Agenda." : `${outOfSync} rendez-vous en attente de mise à jour dans Google Agenda (reprise automatique).`}
        </p>
        {outOfSync > 0 && <Button size="sm" disabled={busy} onClick={() => act(retryCalendarSyncAction, "Synchronisation relancée")}><RefreshCw size={13} /> Relancer maintenant</Button>}
        <p className="text-xs text-muted">
          Sens unique : les réservations, reports et annulations faits dans Cely sont répercutés dans Google. Un événement déplacé ou supprimé
          directement dans Google n&apos;est pas reporté dans Cely (le créneau reste réservé ici) : passez par le back-office pour reporter ou annuler.
        </p>
      </Card>
    </div>
  );
}
