"use client";

// Liste des connecteurs en trois groupes (À vérifier, Connectés, À configurer), et panneau « Gérer ».
// Une vérification ne concerne qu'un service et ne bloque pas le reste de la page.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowUpRight, Bot, CalendarDays, Check, Copy, ExternalLink, Mail, Mic, RefreshCw, Search, X } from "lucide-react";
import { disconnectConnectorAction, revokeMcpGrantAction, verifyConnectorAction } from "@/app/connecteurs-actions";
import { Badge, Button, Spinner, cn } from "@/components/ui";
import { STATE_LABEL, groupOf, type Connector, type ConnectorGroup, type ConnectorKey, type ConnectorState } from "@/lib/connectors/types";

const ICON: Record<ConnectorKey, typeof Mail> = { gmail: Mail, google_calendar: CalendarDays, fireflies: Mic, claude_mcp: Bot, ubersuggest: Search };
const TONE: Record<ConnectorState, "success" | "danger" | "warning" | "violet" | "neutral" | "ink"> = {
  connected: "success", reconnect: "danger", sync_error: "warning", to_verify: "violet", not_connected: "neutral", claude: "neutral", unknown: "warning",
};
const GROUPS: { key: ConnectorGroup; title: string }[] = [
  { key: "attention", title: "À vérifier" },
  { key: "connected", title: "Connectés" },
  { key: "setup", title: "À configurer" },
];

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(d).replace(":", " h ");
  const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" });
  if (day.format(d) === day.format(today)) return `aujourd'hui à ${time}`;
  if (day.format(d) === day.format(new Date(today.getTime() - 864e5))) return `hier à ${time}`;
  return `le ${day.format(d)} à ${time}`;
};

export function StateBadge({ state }: { state: ConnectorState }) {
  return <Badge tone={TONE[state]}>{state === "connected" && <Check size={11} aria-hidden />}{(state === "reconnect" || state === "sync_error") && <AlertTriangle size={11} aria-hidden />}{STATE_LABEL[state]}</Badge>;
}

export function ConnectorsView({ initial }: { initial: Connector[] }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [busy, setBusy] = useState<ConnectorKey | null>(null);
  const [open, setOpen] = useState<ConnectorKey | null>(null);
  const [, start] = useTransition();
  const current = list.find((c) => c.key === open) ?? null;

  const verify = (key: ConnectorKey) => {
    setBusy(key);
    start(async () => {
      const r = await verifyConnectorAction(key);
      setBusy(null);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.connector) setList((l) => l.map((c) => (c.key === key ? r.data.connector! : c)));
      (r.data.ok ? toast.success : toast.error)(r.data.message);
    });
  };
  const refresh = () => router.refresh();

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const items = list.filter((c) => groupOf(c.state) === g.key);
        if (!items.length) return null;
        return (
          <section key={g.key} aria-labelledby={`g-${g.key}`} data-group={g.key}>
            <h2 id={`g-${g.key}`} className={cn("mb-2 font-label text-xs font-bold tracking-wide uppercase", g.key === "attention" ? "text-danger" : "text-muted")}>{g.title}</h2>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
              {items.map((c) => <Row key={c.key} c={c} busy={busy === c.key} onVerify={() => verify(c.key)} onManage={() => setOpen(c.key)} />)}
            </ul>
          </section>
        );
      })}
      {current && <Panel c={current} busy={busy === current.key} onClose={() => setOpen(null)} onVerify={() => verify(current.key)} onChanged={refresh} />}
      <p className="text-xs text-muted">États enregistrés par le CRM à l&apos;ouverture de la page ; « Vérifier » interroge le service concerné, lui seul.</p>
    </div>
  );
}

function Row({ c, busy, onVerify, onManage }: { c: Connector; busy: boolean; onVerify: () => void; onManage: () => void }) {
  const Icon = ICON[c.key];
  const meta = [c.account, c.lastSuccess && `${c.lastSuccess.label} ${when(c.lastSuccess.at)}`].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-connector={c.key}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface text-ink" aria-hidden><Icon size={18} /></span>
      <div className="min-w-[60%] flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <button type="button" onClick={onManage} className="font-semibold text-ink hover:text-violet-strong">{c.name}</button>
          <span className="text-sm text-muted"><span aria-hidden>· </span>{c.usage}</span>
        </p>
        {meta && <p className="truncate text-xs text-muted">{meta}</p>}
        {c.problem ? <p className="text-xs font-semibold text-danger">{c.problem.message}{c.problem.at ? ` (${when(c.problem.at)})` : ""}</p>
          : c.note && <p className="text-xs text-muted">{c.note}</p>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <StateBadge state={c.state} />
        <Primary c={c} busy={busy} onVerify={onVerify} onManage={onManage} />
      </div>
    </li>
  );
}

function Primary({ c, busy, onVerify, onManage }: { c: Connector; busy: boolean; onVerify: () => void; onManage: () => void }) {
  const p = c.primary;
  const strong = c.state === "reconnect" || c.state === "not_connected" || c.state === "to_verify";
  if (p.kind === "verify") return <Button size="sm" variant={strong ? "primary" : "secondary"} disabled={busy} onClick={onVerify}>{busy ? <Spinner /> : <RefreshCw size={13} />} {p.label}</Button>;
  if (p.kind === "link") return <a href={p.href} className={cn("inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-semibold", strong ? "bg-ink text-white hover:bg-violet-strong" : "border border-line hover:bg-surface")}>{p.label}</a>;
  return <Button size="sm" variant={strong ? "primary" : "secondary"} onClick={onManage}>{p.label}</Button>;
}

// ---------------------------------------------------------------------------
// Panneau « Gérer »
// ---------------------------------------------------------------------------

function Panel({ c, busy, onClose, onVerify, onChanged }: { c: Connector; busy: boolean; onClose: () => void; onVerify: () => void; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const Icon = ICON[c.key];
  const disconnect = () => {
    if (!c.disconnect || !confirm(`${c.disconnect.label} ?\n\n${c.disconnect.effect}`)) return;
    start(async () => {
      const r = await disconnectConnectorAction(c.key);
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.revoked ? "Déconnecté, accès révoqué chez le fournisseur." : "Déconnecté. La révocation chez le fournisseur n'a pas pu être confirmée : retirez l'accès depuis votre compte Google.");
      onClose();
      onChanged();
    });
  };
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-ink/20" aria-label="Fermer le détail" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={`Détail : ${c.name}`} className="relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-white p-5 shadow-2xl" data-panel={c.key}>
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface" aria-hidden><Icon size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl font-bold">{c.name}</h2>
            <p className="text-sm text-muted">{c.usage}</p>
            <div className="mt-1.5"><StateBadge state={c.state} /></div>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface"><X size={18} /></button>
        </div>

        {(c.problem || c.lastSuccess || c.lastCheck) && (
          <dl className="mt-4 space-y-1 rounded-xl bg-surface p-3 text-sm">
            {c.lastSuccess && <div className="flex justify-between gap-3"><dt className="text-muted">{c.lastSuccess.label}</dt><dd>{when(c.lastSuccess.at)}</dd></div>}
            {c.problem && <div className="flex justify-between gap-3"><dt className="text-muted">Dernier problème</dt><dd className="text-right font-semibold text-danger">{c.problem.message}{c.problem.at && <span className="block text-xs font-normal">{when(c.problem.at)}</span>}</dd></div>}
            {c.lastCheck && <div className="flex justify-between gap-3"><dt className="text-muted">Dernière vérification</dt><dd className="text-right">{c.lastCheck.ok ? "Réussie" : "Échouée"} {when(c.lastCheck.at)}{c.lastCheck.message && <span className="block text-xs text-muted">{c.lastCheck.message}</span>}</dd></div>}
          </dl>
        )}

        <Section title="Ce qu'il alimente dans le CRM">
          <ul className="list-disc space-y-0.5 pl-5 text-sm">{c.feeds.map((f) => <li key={f}>{f}</li>)}</ul>
        </Section>

        {c.mcp ? <McpDetail c={c} onChanged={onChanged} /> : (
          <>
            {(c.account || c.permissions.length > 0) && (
              <Section title="Compte et permissions">
                {c.account && <p className="text-sm font-semibold">{c.account}</p>}
                {c.permissions.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">{c.permissions.map((p) => <li key={p}>{p}</li>)}</ul>}
              </Section>
            )}
            {c.settings.length > 0 && (
              <Section title="Paramètres">
                <dl className="divide-y divide-line text-sm">
                  {c.settings.map((s, i) => (
                    <div key={i} className="flex justify-between gap-3 py-1.5">
                      <dt className="text-muted">{s.label}</dt>
                      <dd className={cn("text-right", s.tone === "warn" && "font-semibold text-warning", s.tone === "ok" && "text-success", s.tone === "muted" && "text-muted")}>{s.value}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            )}
          </>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {c.canVerify && <Button disabled={busy} onClick={onVerify}>{busy ? <Spinner /> : <RefreshCw size={14} />} Vérifier maintenant</Button>}
          {c.reconnectHref && c.state !== "claude" && <a href={c.reconnectHref} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-semibold text-white hover:bg-violet-strong">{c.state === "not_connected" ? "Connecter" : "Reconnecter"}</a>}
          {c.disconnect && <Button variant="danger" disabled={pending} onClick={disconnect}>{c.disconnect.label}</Button>}
        </div>
        {c.disconnect && <p className="mt-2 text-xs text-muted">{c.disconnect.effect}</p>}

        {c.links.length > 0 && (
          <Section title="Rubrique du CRM">
            <ul className="space-y-1">{c.links.map((l) => <li key={l.href}><Link href={l.href} className="inline-flex items-center gap-1 text-sm font-semibold text-violet-strong hover:underline">{l.label} <ArrowUpRight size={13} /></Link></li>)}</ul>
          </Section>
        )}
        {c.external && <Section title="Hors du CRM"><p className="text-sm text-muted">{c.external}</p></Section>}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 font-label text-[11px] font-bold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function McpDetail({ c, onChanged }: { c: Connector; onChanged: () => void }) {
  const m = c.mcp!;
  const [pending, start] = useTransition();
  const [grants, setGrants] = useState(m.grants);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.url);
      toast.success("Adresse copiée");
    } catch {
      toast.error("Copie impossible : sélectionnez l'adresse à la main.");
    }
  };
  const revoke = (clientId: string, name: string) => {
    if (!confirm(`Retirer l'accès de « ${name} » au CRM ?\n\nCe client ne pourra plus obtenir de nouvel accès ; un jeton déjà émis reste valable au plus une heure. Il faudra reconnecter le connecteur dans Claude pour le réutiliser.`)) return;
    start(async () => {
      const r = await revokeMcpGrantAction(clientId);
      if (!r.ok) return void toast.error(r.error);
      setGrants((g) => (g ?? []).filter((x) => x.clientId !== clientId));
      toast.success("Accès retiré");
      onChanged();
    });
  };
  return (
    <>
      <Section title="Serveur MCP du CRM">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-3 py-2 text-sm" data-mcp-url>{m.url}</code>
          <Button size="sm" onClick={copy} aria-label="Copier l'URL du serveur MCP"><Copy size={13} /> Copier l&apos;URL</Button>
        </div>
        <p className="mt-1.5 text-xs text-muted">{m.auth}</p>
        <p className="mt-1 text-xs text-muted">Un serveur joignable ne prouve pas qu&apos;un Claude est connecté : seuls les accès ci-dessous le montrent.</p>
      </Section>
      <Section title="Accès accordés">
        {grants === null ? (
          <p className="text-sm text-warning">{m.grantsError ?? "Liste indisponible."} Clients non identifiables individuellement pour le moment.</p>
        ) : grants.length === 0 ? (
          <p className="text-sm text-muted">Aucun accès accordé. Ajoutez l&apos;URL ci-dessus comme connecteur personnalisé dans Claude, puis autorisez-le avec votre compte.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" data-grants>
            {grants.map((g) => (
              <li key={g.clientId} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{g.name}</p>
                  <p className="text-xs text-muted">{g.grantedAt ? `Autorisé ${when(g.grantedAt)}` : "Date d'autorisation inconnue"}{g.scopes.length ? ` · ${g.scopes.join(", ")}` : ""}</p>
                </div>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => revoke(g.clientId, g.name)}>Retirer</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Usages">
        <p className="text-sm text-muted">
          {grants && grants.length > 1
            ? "Chaque accès ci-dessus correspond à un client Claude distinct : vous pouvez en retirer un sans toucher aux autres."
            : grants && grants.length === 1
              ? `Un seul accès (« ${grants[0].name} ») : vos usages de Claude (quotidien, diagnostic…) le partagent. Pour les distinguer et les retirer séparément, ajoutez le connecteur depuis chaque espace Claude concerné : chacun obtiendra son propre accès.`
              : "Aucun usage identifiable tant qu'aucun accès n'est accordé."}
        </p>
        <p className="mt-1.5 text-xs text-muted">
          Dernière écriture de Claude dans le CRM : {m.lastWrite ? when(m.lastWrite) : "aucune"} (tous accès confondus : le journal ne distingue pas les clients, et les lectures ne sont pas journalisées).
        </p>
      </Section>
      <Section title="Gérés dans Claude">
        <p className="text-sm text-muted">Les autres outils branchés sur Claude (Ubersuggest…) n&apos;ont aucun accès au CRM. <a className="inline-flex items-center gap-0.5 font-semibold text-violet-strong" href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">Connecteurs de Claude <ExternalLink size={11} /></a></p>
      </Section>
    </>
  );
}
