import "server-only";
// Synchronisation de toute la boîte Gmail vers l'index du CRM (lot M01).
// - Première fois (ou historique expiré) : la boîte est relue en entier, par lots, du plus récent au plus ancien ;
//   chaque lot enregistre où il s'est arrêté, donc une coupure reprend au lot suivant sans rien perdre.
// - Ensuite : seuls les changements depuis le dernier repère sont relus (arrivées, suppressions, libellés, lu…).
// Fonctionne sans session : toutes les écritures passent par des fonctions à clé serveur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { rpc } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { GMAIL_READ_SCOPE } from "./google";
import { GmailBoxError, getBoxMessage, listChanges, listLabels, listMessageIds, pooled, profileHistoryId, type BoxMessage } from "./gmail-box";

/** Gère aussi le tri (lots suivants) ; elle inclut la lecture. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const canReadBox = (scopes: string[]) => scopes.includes(GMAIL_READ_SCOPE) || scopes.includes(GMAIL_MODIFY_SCOPE) || scopes.includes("https://mail.google.com/");

type State = { history_id: string | null; generation: number; backfill_token: string | null; backfill_done: boolean };
type Applied = { upserted: number; deleted: number };

export type BoxSyncResult =
  | { skipped: string }
  | { mode: "initiale" | "incrementale"; ajoutes_ou_modifies: number; supprimes: number; lecture_complete_terminee: boolean; a_suivre: boolean };

const PAGE = 100; // messages par lot de relecture
const PARALLEL = 10; // lectures simultanées : sous le quota Gmail par utilisateur

/**
 * Un passage, borné dans le temps (`budgetMs`). Sans erreur : l'index reflète Gmail jusqu'au repère enregistré.
 * Avec erreur : le motif est enregistré (affiché dans la page Mail), les repères restent en place, puis l'erreur
 * est relancée pour le rapport du passage planifié.
 */
export async function syncMailbox(sb: SupabaseClient, account: { id: string; scopes: string[] }, token: string, opts: { budgetMs?: number } = {}): Promise<BoxSyncResult> {
  const key = serverRpcKey();
  const call = <T>(fn: string, args: Record<string, unknown> = {}) => rpc<T>(sb, fn, { p_server_key: key, p_account: account.id, ...args });
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);
  const timeLeft = () => Date.now() < deadline;

  const claimed = await call<State | null>("mailbox_sync_claim", { p_ttl: 90 });
  if (!claimed) return { skipped: "Une synchronisation de la boîte est déjà en cours" };
  const state: State = claimed;

  if (!canReadBox(account.scopes)) {
    const message = "La lecture de la boîte n'est pas autorisée. Reconnectez Gmail en acceptant toutes les autorisations demandées.";
    await call("mailbox_sync_fail", { p_code: "scope", p_error: message });
    return { skipped: message };
  }

  let upserted = 0, deleted = 0;
  const apply = async (p: Record<string, unknown>) => {
    const r = await call<Applied>("mailbox_apply", { p });
    upserted += r.upserted;
    deleted += r.deleted;
  };
  const fetchAll = async (ids: string[]) => {
    const found: BoxMessage[] = [];
    const gone: string[] = [];
    (await pooled(ids, PARALLEL, (id) => getBoxMessage(token, id))).forEach((m, i) => (m ? found.push(m) : gone.push(ids[i])));
    return { found, gone };
  };

  let mode: "initiale" | "incrementale" = state.backfill_done ? "incrementale" : "initiale";
  let pending = false;
  try {
    // 1. Changements depuis le dernier repère (aussi pendant une relecture complète : le courrier arrive tout de suite)
    if (state.history_id) {
      try {
        // page par page : chaque page écrite fait avancer le repère, même si le temps imparti s'arrête avant la fin
        pending = true;
        while (pending) {
          const ch = await listChanges(token, state.history_id);
          const { found, gone } = await fetchAll(ch.changed);
          await apply({ upserts: found, deleted: [...ch.deleted, ...gone], history_id: ch.historyId });
          const stuck = !ch.complete && ch.historyId === state.history_id;
          state.history_id = ch.historyId;
          pending = !ch.complete;
          if (stuck || !timeLeft()) break;
        }
      } catch (e) {
        if (!(e instanceof GmailBoxError && e.code === "expired")) throw e;
        state.history_id = null; // repère trop ancien : relecture complète ci-dessous
        pending = false;
      }
    }

    // 2. Relecture complète : démarrage (repère pris avant la lecture), puis lots jusqu'à la fin ou au temps imparti
    if (!state.history_id) {
      const historyId = await profileHistoryId(token);
      state.generation = await call<number>("mailbox_sync_begin", { p_history_id: historyId });
      state.history_id = historyId;
      state.backfill_token = null;
      state.backfill_done = false;
      mode = "initiale";
    }

    // 3. Libellés et compteurs (dossiers, catégories, libellés personnels)
    await apply({ labels: await listLabels(token) });

    while (!state.backfill_done && timeLeft()) {
      const page = await listMessageIds(token, state.backfill_token, PAGE);
      const { found } = await fetchAll(page.ids);
      await apply({ upserts: found, backfill: { token: page.next, done: !page.next } });
      state.backfill_token = page.next;
      state.backfill_done = !page.next;
    }

    await call("mailbox_sync_release");
    return { mode, ajoutes_ou_modifies: upserted, supprimes: deleted, lecture_complete_terminee: state.backfill_done, a_suivre: pending || !state.backfill_done };
  } catch (e) {
    const known = e instanceof GmailBoxError;
    await call("mailbox_sync_fail", {
      p_code: known ? e.code : "internal",
      p_error: known ? e.message : "La synchronisation de la boîte a échoué. Elle reprendra seule au prochain passage.",
    }).catch(() => undefined);
    throw known ? e : new Error("Synchronisation de la boîte impossible");
  }
}
