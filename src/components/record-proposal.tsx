"use client";

// Onglet Proposition de la fiche : l'écran commun des générateurs, plus ce qui est propre à la proposition
// (devis créé par Make, envoi par le module Mail, signature).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, FileText, PenLine, RotateCcw, Send } from "lucide-react";
import { apiGet } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import type { Answers, GeneratorDossier, GeneratorVersion } from "@/lib/generators/rules";
import { QUOTE_STATUS_LABELS, QUOTE_STATUS_TONES, eurCents, quotePayload, quoteRetryable, sendEmailDraft, type ProposalExtras } from "@/lib/proposals/rules";
import type { RecordCtx } from "./company-record";
import { GeneratorPanel, generatorKey } from "./generator/panel";
import { post } from "./generator/shared";
import { Badge, Button } from "./ui";

/** Ce qui part à Make : le client, le signataire et les lignes, tels que saisis. */
function MakeRecap({ answers }: { answers: Answers }) {
  const p = quotePayload("", answers);
  const a = p.client.billing_address;
  return (
    <div className="grid gap-1.5">
      <p><span className="text-muted">Client : </span>{p.client.company_name}{[a.line1, [a.postal_code, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).length ? ` · ${[a.line1, [a.postal_code, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ")}` : ""}{p.client.siret && ` · SIRET ${p.client.siret}`}</p>
      <p><span className="text-muted">Signataire : </span>{[`${p.signatory.first_name} ${p.signatory.last_name}`.trim(), p.signatory.title, p.signatory.email].filter(Boolean).join(" · ")}</p>
      <p><span className="text-muted">Démarrage : </span>{p.quote.start_date.split("-").reverse().join("/")}{p.quote.duration_months != null && ` · ${p.quote.duration_months} mois`} · {p.quote.payment_terms}</p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {p.quote.lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-3 px-3 py-1.5">
            <span>{l.label} <span className="text-muted">· {l.quantity} {l.unit} × {eurCents(l.unit_price_cents)} HT{l.recurrence === "monthly" ? " / mois" : ""} · TVA {l.vat_rate} %</span></span>
            <span className="font-semibold">{eurCents(Math.round(l.quantity * l.unit_price_cents))}</span>
          </li>
        ))}
        <li className="flex justify-between gap-3 px-3 py-1.5 font-semibold"><span>Total HT</span><span data-recap-total>{eurCents(p.quote.total_ht_cents)}</span></li>
      </ul>
      <p className="text-xs text-muted">Ces montants viennent de vos réponses. L&apos;IA ne les modifie pas et ne les estime pas.</p>
    </div>
  );
}

function VersionExtra({ ctx, d, v, reload, after }: { ctx: RecordCtx; d: GeneratorDossier; v: GeneratorVersion; reload: () => void; after?: (signedVersion: GeneratorVersion) => React.ReactNode }) {
  const qc = useQueryClient();
  const key = ["proposal-extras", d.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<ProposalExtras>(`/api/generateurs/${d.id}?vue=proposition`, signal),
    refetchInterval: (q) => (Object.values(q.state.data?.versions ?? {}).some((x) => x.quote.status === "requested") ? 15_000 : false),
  });
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const pv = data?.versions[v.id];
  if (!pv) return null;
  const q = pv.quote;
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); reload(); };
  const c = ctx.detail.company;

  async function run(body: Record<string, unknown>, done: (r: Record<string, unknown>) => void) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const r = await post<Record<string, unknown>>(`/api/generateurs/${d.id}`, body);
    lock.current = false;
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    done(r.data ?? {});
    refresh();
  }
  const sign = () => {
    if (!confirm(`Marquer la V${v.version} comme signée ?\n\nLa fiche passera en client (vente, projet et préparation de l'onboarding), comme avec « Passer en client ».`)) return;
    void run({ op: "sign", version_id: v.id }, (r) => {
      if (r.status === "won") toast.success(`Proposition signée : ${c.name} est passé en client`);
      else if (r.status === "to_confirm") toast.message(`Proposition signée. Passage en client à confirmer : ${r.reason}`);
      else toast.success("Proposition signée");
      ctx.reload();
    });
  };
  const retryQuote = () => run({ op: "quote_retry", quote_id: q.id }, (r) => (r.error ? toast.error(`Devis à relancer : ${r.error}`) : r.sent ? toast.success("Devis demandé à Make") : toast.message("Le devis est déjà en cours de création.")));
  const markSent = (mailId: string | null) => run({ op: "sent", version_id: v.id, mail_id: mailId }, () => toast.success(`Proposition V${v.version} envoyée`));
  const send = () => {
    const signer = v.answers.signataire?.value as { first_name?: string; email?: string | null; person_id?: string | null } | undefined;
    const draft = sendEmailDraft(c.name.replace(/^\[TEST\]\s*/, ""), signer?.first_name ?? null, q.url ? q : null);
    ctx.compose({ to: signer?.email ?? null, personId: signer?.person_id ?? null, prefill: { ...draft, fileIds: v.file_id ? [v.file_id] : [] }, onSent: (m) => void markSent(m.id) });
  };

  return (
    <div className="mt-2 grid gap-2 border-t border-line pt-2" data-quote={q.status}>
      <div className="flex flex-wrap items-center gap-2">
        <FileText size={14} className="text-muted" aria-hidden />
        <span className="font-semibold">Devis</span>
        <Badge tone={QUOTE_STATUS_TONES[q.status]}>{QUOTE_STATUS_LABELS[q.status]}</Badge>
        {q.number && <span data-quote-number>{q.number}</span>}
        <span className="text-muted">{eurCents(q.total_ht_cents)} HT</span>
        {q.url && <a className="inline-flex items-center gap-1 font-semibold text-violet-strong hover:underline" href={q.url} target="_blank" rel="noreferrer noopener">Ouvrir le devis <ExternalLink size={12} /></a>}
        {quoteRetryable(q) && (
          <Button size="sm" className="ml-auto" disabled={busy || !data.makeReady} onClick={retryQuote} title={data.makeReady ? undefined : "Scénario « Créer le devis » non configuré"}>
            <RotateCcw size={13} /> {q.status === "to_send" ? "Créer le devis" : "Relancer le devis"}
          </Button>
        )}
      </div>
      {q.error && <p className="text-xs text-danger">{q.error}</p>}
      {!data.makeReady && q.status !== "signed" && <p className="text-xs text-warning">Scénario « Créer le devis » non configuré : Paramètres › Connecteurs › Make.</p>}
      {q.status === "requested" && <p className="text-xs text-muted">Make crée le devis. Son numéro et son lien arriveront ici.</p>}

      {v.validated_at && !pv.signed_at && !data.signed && (
        <div className="flex flex-wrap items-center gap-2">
          {!v.sent_at ? (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={send} data-send-proposal><Send size={13} /> Envoyer la proposition</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(`Marquer la V${v.version} comme envoyée, sans passer par le module Mail ?`)) void markSent(null); }}>Déjà envoyée autrement</Button>
              {!q.url && <span className="text-xs text-muted">Le lien du devis sera ajouté à l&apos;email dès que Make l&apos;aura renvoyé.</span>}
            </>
          ) : <span className="text-xs text-muted"><Check size={12} className="inline" aria-hidden /> Envoyée le {formatDateTime(v.sent_at)}</span>}
          <Button size="sm" className="ml-auto" disabled={busy} onClick={sign} data-mark-signed><PenLine size={13} /> Marquer comme signée</Button>
        </div>
      )}
      {pv.signed_at && (
        <div className="grid gap-2" data-signed>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success"><PenLine size={11} aria-hidden /> Signée le {formatDateTime(pv.signed_at)}{pv.signed_via === "manual" ? " (marquée à la main)" : ""}</Badge>
            {data.client.status === "won" && <Badge tone="success">Client</Badge>}
            {data.client.status === "won" && after?.(v)}
          </div>
          {data.signed?.older && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-warning" data-signed-older>C&apos;est la V{v.version} qui a été signée, alors qu&apos;une version plus récente existe. La V{v.version} fait foi pour l&apos;onboarding.</p>}
          {data.client.status !== "won" && (
            <div className="flex flex-wrap items-center gap-2 text-xs" data-client-to-confirm>
              <span className="text-warning">{data.client.to_confirm ?? "Le passage en client se fait à l'ouverture du CRM."}</span>
              <Button size="sm" variant="primary" onClick={() => ctx.makeClient()}>Passer en client</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Signatures reçues de Make pendant mon absence : à l'ouverture, chaque proposition signée passe en client par la
 * logique existante (une seule fois). Sans effet s'il n'y a rien à faire.
 */
export function useFinalizeSignatures(onDone: (won: number) => void) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void post<{ status: string }[]>("/api/propositions/finaliser", {}).then((r) => {
      if (!r.ok) return;
      const won = r.data.filter((x) => x.status === "won").length;
      if (won) toast.success(won > 1 ? `${won} propositions signées : fiches passées en client` : "Proposition signée : la fiche est passée en client");
      if (r.data.length) onDone(won);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une seule fois à l'ouverture
  }, []);
}

export function RecordProposal({ ctx, versionActions, after }: {
  ctx: RecordCtx;
  /** actions supplémentaires d'une version (signature : lot suivant) */
  versionActions?: (d: GeneratorDossier, v: GeneratorVersion, reload: () => void) => React.ReactNode;
  after?: (signedVersion: GeneratorVersion) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const c = ctx.detail.company;
  useFinalizeSignatures(() => { ctx.reload(); void qc.invalidateQueries({ queryKey: ["proposal-extras"] }); });
  return (
    <GeneratorPanel
      companyId={c.id}
      kind="proposal"
      people={ctx.detail.people}
      slots={{
        recapMake: (answers) => <MakeRecap answers={answers} />,
        versionExtra: (d, v, reload) => (
          <>
            <VersionExtra ctx={ctx} d={d} v={v} after={after} reload={() => { reload(); void qc.invalidateQueries({ queryKey: generatorKey("proposal", c.id) }); }} />
            {versionActions?.(d, v, reload)}
          </>
        ),
      }}
    />
  );
}
