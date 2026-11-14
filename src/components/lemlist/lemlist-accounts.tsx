"use client";

// Connecteurs › lemlist clients : un compte lemlist par fiche client, ajouté avec la clé API du client.
// La clé saisie part une seule fois vers le serveur (testée, puis chiffrée) et n'est jamais réaffichée.
// Chaque compte a son propre état : un compte à reconnecter ne gêne pas les autres.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Plus, RefreshCw, Send } from "lucide-react";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Spinner } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import { LEMLIST_STATUS_LABEL, type LemlistAccount, type LemlistOverview } from "@/lib/lemlist/types";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const KEY = ["lemlist-accounts"];

async function post<T>(body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const res = await fetch("/api/lemlist/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Result<T>;
  } catch {
    return { ok: false, error: "Le serveur n'a pas répondu. Vérifiez votre connexion et réessayez." };
  }
}

const when = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

export function LemlistAccounts() {
  const qc = useQueryClient();
  const { data, error, isPending } = useQuery({ queryKey: KEY, queryFn: ({ signal }) => apiGet<LemlistOverview>("/api/lemlist/accounts", signal) });
  const [adding, setAdding] = useState<{ companyId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: KEY });

  async function verify(a: LemlistAccount) {
    setBusy(a.id);
    const r = await post<{ ok: boolean; message: string }>({ op: "verify", id: a.id });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    (r.data.ok ? toast.success : toast.error)(r.data.message);
    reload();
  }
  async function disconnect(a: LemlistAccount) {
    if (!confirm(`Déconnecter le compte lemlist « ${a.team_name || a.company_name} » ?\n\nSes conversations ne seront plus affichées dans Messages et la clé est effacée du CRM. Elle reste valable chez lemlist : supprimez-la dans lemlist (Réglages › Intégrations) si vous voulez la révoquer.`)) return;
    setBusy(a.id);
    const r = await post({ op: "disconnect", id: a.id });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Compte lemlist déconnecté.");
    reload();
  }

  return (
    <section aria-labelledby="lemlist-clients" className="mt-8" data-section="lemlist-clients">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="lemlist-clients" className="font-label text-xs font-bold tracking-wide text-muted uppercase">lemlist clients</h2>
        <Button size="sm" variant="primary" disabled={!data?.configured} onClick={() => setAdding({ companyId: "" })}><Plus size={13} /> Ajouter un compte</Button>
      </div>
      <p className="mb-3 text-xs text-muted">Les comptes lemlist de vos clients, pour lire et répondre à leurs messages depuis Messages. Un compte appartient à une seule fiche client.</p>
      {isPending ? (
        <div className="rounded-2xl border border-line bg-white p-4"><Spinner /></div>
      ) : error ? (
        <p className="rounded-2xl border border-line bg-white p-4 text-sm font-semibold text-danger">Lecture des comptes lemlist impossible. Rechargez la page.</p>
      ) : !data.configured ? (
        <p className="rounded-2xl border border-line bg-white p-4 text-sm text-muted">Chiffrement indisponible : la clé de chiffrement du serveur manque dans Vercel (voir docs/messages-lemlist.md). Aucun compte ne peut être ajouté tant qu&apos;elle manque.</p>
      ) : !data.accounts.length ? (
        <EmptyState title="Aucun compte lemlist" description="Ajoutez le compte d'un client avec sa clé API lemlist (lemlist › Réglages › Intégrations)." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-lemlist-account={a.id}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface text-ink" aria-hidden><Send size={16} /></span>
              <div className="min-w-[55%] flex-1">
                <p className="font-semibold text-ink">{a.company_name}{a.company_archived && <span className="ml-2 text-xs font-normal text-muted">(fiche archivée)</span>}</p>
                <p className="truncate text-xs text-muted">Équipe lemlist : {a.team_name || "sans nom"}{a.last_ok_at ? ` · dernier accès réussi le ${when(a.last_ok_at)}` : ""}</p>
                {a.status === "needs_reconnect" && <p className="text-xs font-semibold text-danger">{a.last_error ?? "Clé refusée par lemlist."} Collez une nouvelle clé pour reconnecter ce compte.</p>}
                {a.status === "connected" && a.last_error && <p className="text-xs text-amber-800">Dernier essai en échec : {a.last_error}</p>}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Badge tone={a.status === "connected" ? "success" : "danger"}>
                  {a.status === "connected" ? <Check size={11} aria-hidden /> : <AlertTriangle size={11} aria-hidden />}
                  {LEMLIST_STATUS_LABEL[a.status]}
                </Badge>
                {a.status === "needs_reconnect" ? (
                  <Button size="sm" variant="primary" onClick={() => setAdding({ companyId: a.company_id })}>Reconnecter</Button>
                ) : (
                  <Button size="sm" disabled={busy === a.id} onClick={() => verify(a)}>{busy === a.id ? <Spinner /> : <RefreshCw size={13} />} Vérifier</Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => disconnect(a)}>Déconnecter</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && data && <AddAccount clients={data.clients} initialCompany={adding.companyId} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} />}
    </section>
  );
}

function AddAccount({ clients, initialCompany, onClose, onDone }: { clients: LemlistOverview["clients"]; initialCompany: string; onClose: () => void; onDone: () => void }) {
  const [companyId, setCompanyId] = useState(initialCompany);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await post<LemlistAccount>({ op: "connect", companyId, apiKey });
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    setApiKey("");
    toast.success(`Compte lemlist connecté : ${r.data.team_name || "équipe sans nom"} (${r.data.company_name}).`);
    onDone();
  }

  return (
    <Modal open onClose={onClose} title="Ajouter un compte lemlist">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Fiche du client">
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
            <option value="">Choisir…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? " (archivée)" : ""}</option>)}
          </Select>
        </Field>
        {!clients.length && <p className="text-xs text-muted">Aucune fiche client : passez d&apos;abord la fiche en client (vente gagnée).</p>}
        <Field label="Clé API lemlist du client" hint="Dans le lemlist du client : Réglages › Intégrations › Générer une clé API. Elle est testée, puis enregistrée chiffrée ; le CRM ne la réaffiche jamais.">
          <Input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        </Field>
        {problem && <p role="alert" className="text-sm font-semibold text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" disabled={busy || !companyId || !apiKey.trim()}>{busy ? <Spinner /> : null} Tester et connecter</Button>
        </div>
      </form>
    </Modal>
  );
}
