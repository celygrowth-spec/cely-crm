"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink, Pencil, Plus } from "lucide-react";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { InvoiceBadge, Money } from "@/components/finance/bits";
import { InvoiceModal, MissionModal, type ClientOption, type InvoiceDefaults } from "@/components/finance/forms";
import { activeClientIds, contractualMrr, settingsAt } from "@/lib/finance/calc";
import { DEAL_STATUS_LABELS, formatDate, relativeDay } from "@/lib/format";
import { FREQUENCY, MISSION_KIND, MISSION_STATUS } from "@/lib/finance/labels";
import { eur, sum } from "@/lib/finance/money";
import type { FinanceData, Mission } from "@/lib/finance/types";

export type CompanyInfo = {
  id: string;
  name: string;
  website: string | null;
  deal_status: keyof typeof DEAL_STATUS_LABELS | null;
  amount: number | null;
  stage: string | null;
  last_interaction_at: string | null;
  primary_person_name: string | null;
  primary_person_email: string | null;
  next_action_title: string | null;
  next_action_due: string | null;
};

const statusTone = { a_demarrer: "neutral", actif: "success", en_pause: "warning", termine: "neutral" } as const;

export function ClientsView({ data, companies, showAll, recurringOnly }: { data: FinanceData; companies: CompanyInfo[]; showAll: boolean; recurringOnly: boolean }) {
  const { openCompany } = useCrm();
  const [missionModal, setMissionModal] = useState<{ mission: Mission | null; company: ClientOption | null } | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDefaults | null>(null);
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const active = new Set(activeClientIds(data.missions));
  const ids = [...new Set([...data.missions.map((m) => m.company_id), ...data.invoices.map((i) => i.company_id)])].filter(
    (id) => showAll || active.has(id) || data.missions.some((m) => m.company_id === id && m.status === "a_demarrer") || data.invoices.some((i) => i.company_id === id && i.balance > 0),
  );
  const rows = ids
    .map((id) => {
      const missions = data.missions.filter((m) => m.company_id === id && (!recurringOnly || m.kind === "recurrent"));
      const invoices = data.invoices.filter((i) => i.company_id === id && !i.cancelled_at);
      const info = companies.find((c) => c.id === id);
      const invoiced = sum(invoices.map((i) => (i.kind === "avoir" ? -i.amount_ttc : i.amount_ttc)));
      const received = sum(invoices.filter((i) => i.kind === "facture").map((i) => i.paid_net));
      const remaining = sum(invoices.map((i) => i.balance));
      return { id, name: info?.name ?? missions[0]?.company_name ?? invoices[0]?.company_name ?? "Fiche", info, missions, invoices, invoiced, received, remaining };
    })
    .filter((r) => !recurringOnly || r.missions.length)
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  const clientOptions = rows.map((r) => ({ id: r.id, name: r.name }));
  const mrr = contractualMrr(data.missions);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Clients actifs"
        description="Missions par fiche CRM, avec ce qui est facturé, encaissé et reste dû. Un deal gagné n'implique aucun encaissement."
        actions={
          <>
            <Link href={showAll ? "/finance/clients" : "/finance/clients?tous=1"} className="text-xs font-semibold text-violet-strong">
              {showAll ? "Masquer les clients inactifs" : "Afficher tous les clients"}
            </Link>
            <Button variant="primary" onClick={() => setMissionModal({ mission: null, company: null })}><Plus size={15} /> Nouvelle mission</Button>
          </>
        }
      />
      <p className="mb-4 text-sm text-muted">
        {active.size} client(s) actif(s) · revenu mensuel récurrent contractuel <span className="font-semibold text-ink"><Money value={mrr} /></span> HT
        {recurringOnly && <> · <Link className="font-semibold text-violet-strong" href="/finance/clients">missions récurrentes uniquement (retirer le filtre)</Link></>}
      </p>
      {!rows.length && (
        <EmptyState
          title="Aucun client actif"
          description="Créez une mission depuis une fiche du CRM : c'est la même base clients que la prospection et les pipelines."
          action={<Button variant="primary" onClick={() => setMissionModal({ mission: null, company: null })}>Nouvelle mission</Button>}
        />
      )}
      <div className="space-y-3">
        {rows.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <button onClick={() => openCompany(r.id)} className="flex items-center gap-1 font-display text-lg font-bold hover:text-violet-strong">
                  {r.name} <ExternalLink size={14} aria-hidden />
                </button>
                <p className="text-xs text-muted">
                  {r.info?.stage && <>{r.info.stage} · </>}
                  {r.info?.deal_status && <>Commercial : {DEAL_STATUS_LABELS[r.info.deal_status]}{r.info.amount != null && ` (${eur(Math.round(r.info.amount * 100), { round: true })} au pipeline)`} · </>}
                  {r.info?.primary_person_name && <>{r.info.primary_person_name} · </>}
                  Dernier échange {r.info?.last_interaction_at ? relativeDay(r.info.last_interaction_at) : "—"}
                  {r.info?.next_action_title && <> · Prochaine action : {r.info.next_action_title} ({relativeDay(r.info.next_action_due)})</>}
                </p>
              </div>
              <dl className="grid grid-cols-3 gap-4 text-right text-sm">
                <div><dt className="font-label text-[11px] text-muted">Facturé TTC</dt><dd className="font-semibold">{eur(r.invoiced)}</dd></div>
                <div><dt className="font-label text-[11px] text-muted">Encaissé</dt><dd className="font-semibold">{eur(r.received)}</dd></div>
                <div><dt className="font-label text-[11px] text-muted">Reste dû</dt><dd className={r.remaining ? "font-bold text-ink" : "font-semibold"}>{eur(r.remaining)}</dd></div>
              </dl>
            </div>
            {r.missions.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left font-label text-[11px] text-muted">
                      <th className="py-1">Mission</th><th>Statut</th><th>Type</th><th className="text-right">Montant HT</th><th>Prochaine échéance</th>
                      <th className="text-right">Facturé HT</th><th className="text-right">Encaissé</th><th className="text-right">Reste dû</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {r.missions.map((m) => (
                      <tr key={m.id} className="border-t border-line">
                        <td className="py-1.5 font-semibold">{m.label}</td>
                        <td><Badge tone={statusTone[m.status]}>{MISSION_STATUS[m.status]}</Badge></td>
                        <td className="text-xs">{MISSION_KIND[m.kind]}{m.frequency && ` · ${FREQUENCY[m.frequency].toLowerCase()}`}</td>
                        <td className="text-right"><Money value={m.amount} /></td>
                        <td className="text-xs">
                          {m.next_due_date ? (
                            <span className={m.next_due_date < data.today && m.status === "actif" ? "font-semibold text-danger" : undefined}>
                              {formatDate(m.next_due_date)}{m.next_due_date < data.today && m.status === "actif" && " · à facturer"}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="text-right">{eur(m.invoiced_ht)}</td>
                        <td className="text-right">{eur(m.received)}</td>
                        <td className="text-right">{eur(m.remaining)}</td>
                        <td className="text-right whitespace-nowrap">
                          <Button size="sm" variant="ghost" onClick={() => setInvoice({ company: { id: r.id, name: r.name }, missionId: m.id })}>Facture</Button>
                          <Button size="sm" variant="ghost" aria-label="Modifier la mission" onClick={() => setMissionModal({ mission: m, company: null })}><Pencil size={13} /></Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.invoices.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-muted">Revenus liés ({r.invoices.length})</summary>
                <ul className="mt-1 divide-y divide-line text-sm">
                  {r.invoices.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 py-1">
                      <span className="w-24 text-xs text-muted">{formatDate(i.issue_date)}</span>
                      <Link href={`/finance/revenus?facture=${i.id}`} className="flex-1 hover:text-violet-strong">{i.reference ?? (i.kind === "avoir" ? "Avoir" : "Facture")}{i.mission_label && <span className="text-muted"> · {i.mission_label}</span>}</Link>
                      <InvoiceBadge status={i.status} />
                      <span className="w-24 text-right font-semibold">{i.kind === "avoir" ? "−" : ""}{eur(i.amount_ttc)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => setMissionModal({ mission: null, company: { id: r.id, name: r.name } })}><Plus size={13} /> Mission</Button>
              <Button size="sm" onClick={() => setInvoice({ company: { id: r.id, name: r.name } })}><Plus size={13} /> Revenu</Button>
            </div>
          </Card>
        ))}
      </div>
      <MissionModal open={!!missionModal} onClose={() => setMissionModal(null)} mission={missionModal?.mission ?? null} company={missionModal?.company ?? null} clients={clientOptions} />
      <InvoiceModal open={!!invoice} onClose={() => setInvoice(null)} defaults={invoice ?? {}} missions={data.missions} vatEnabled={vat} clients={clientOptions} />
    </div>
  );
}
