"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Download, ExternalLink } from "lucide-react";
import { addRateAction, deleteRateAction, saveCategoryAction, saveOpeningBalanceAction, saveSettingsAction } from "@/app/finance-actions";
import { Badge, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { MoneyInput } from "@/components/finance/bits";
import { settingsAt } from "@/lib/finance/calc";
import { PERIODICITY, REGIME } from "@/lib/finance/labels";
import { eur, formatRate } from "@/lib/finance/money";
import type { FinanceData, Regime } from "@/lib/finance/types";
import { formatDate, todayISO } from "@/lib/format";
import type { ActionResult } from "@/lib/action";
import { OFFICIAL_SOURCES } from "@/lib/finance/sources";


function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<ActionResult<unknown>>, msg: string, done?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(msg);
      done?.();
      router.refresh();
    });
  return { pending, act };
}

export function FinanceSettingsView({ data }: { data: FinanceData }) {
  const cur = settingsAt(data.settings, data.today);
  const { pending, act } = useAct();
  const [form, setForm] = useState({
    effective_from: todayISO(),
    regime: (cur?.regime ?? "micro_bnc_ssi") as Regime,
    periodicity: cur?.periodicity ?? "monthly",
    acre: cur?.acre ?? false,
    versement_liberatoire: cur?.versement_liberatoire ?? false,
    vat_enabled: cur?.vat_enabled ?? false,
    note: "",
  });
  const [rate, setRate] = useState({ regime: "micro_bnc_ssi", kind: "social", rate: "", effective_from: todayISO(), source_url: "", note: "" });
  const [opening, setOpening] = useState<number | null>(data.opening?.amount ?? null);
  const [openingDate, setOpeningDate] = useState(data.opening?.as_of ?? todayISO());
  const [newCat, setNewCat] = useState("");

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Réglages Finance" description="Chaque réglage a une date d'effet : les périodes passées gardent les réglages et taux qui s'appliquaient alors." />

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Statut et déclaration</h2>
        <p className="text-sm text-muted">En vigueur : {cur ? <>{REGIME[cur.regime]} · {PERIODICITY[cur.periodicity].toLowerCase()} · TVA {cur.vat_enabled ? "activée" : "non applicable"} (depuis le {formatDate(cur.effective_from)})</> : "aucun"}</p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => saveSettingsAction(form), "Réglage enregistré");
          }}
        >
          <Field label="Régime"><Select value={form.regime} onChange={(e) => setForm({ ...form, regime: e.target.value as Regime })}>{Object.entries(REGIME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Périodicité de déclaration"><Select value={form.periodicity} onChange={(e) => setForm({ ...form, periodicity: e.target.value as "monthly" | "quarterly" })}>{Object.entries(PERIODICITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <div className="space-y-1.5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.vat_enabled} onChange={(e) => setForm({ ...form, vat_enabled: e.target.checked })} /> Je facture la TVA (champs HT / TVA / TTC)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.acre} onChange={(e) => setForm({ ...form, acre: e.target.checked })} /> ACRE en cours (estimation désactivée, suivi manuel)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.versement_liberatoire} onChange={(e) => setForm({ ...form, versement_liberatoire: e.target.checked })} /> Versement libératoire (non inclus dans les estimations)</label>
          </div>
          <Field label="Date d'effet" hint="Les périodes antérieures ne changent pas."><Input type="date" required value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></Field>
          <div className="sm:col-span-2 flex justify-end"><Button type="submit" variant="primary" disabled={pending}>Enregistrer ce réglage</Button></div>
        </form>
        {form.regime === "manual" && <p className="mt-2 text-xs text-warning">Suivi manuel : l&apos;application n&apos;estime pas vos cotisations. Vous saisissez estimation, déclaration et paiement dans l&apos;onglet URSSAF.</p>}
        {data.settings.length > 1 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer font-semibold text-muted">Historique ({data.settings.length})</summary>
            <ul className="mt-1 space-y-0.5 text-muted">{[...data.settings].reverse().map((s) => <li key={s.id}>Depuis le {formatDate(s.effective_from)} : {REGIME[s.regime]}, {PERIODICITY[s.periodicity].toLowerCase()}, TVA {s.vat_enabled ? "oui" : "non"}{s.acre && ", ACRE"}{s.versement_liberatoire && ", versement libératoire"}</li>)}</ul>
          </details>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Taux de cotisations</h2>
        <p className="text-sm text-muted">Chaque taux s&apos;applique aux périodes qui commencent à partir de sa date d&apos;effet. Un changement de taux ne modifie jamais une déclaration déjà enregistrée.</p>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left font-label text-[11px] text-muted"><th className="py-1">Régime</th><th>Type</th><th>Taux</th><th>Depuis</th><th>Source</th><th /></tr></thead>
          <tbody>
            {[...data.rates].sort((a, b) => a.regime.localeCompare(b.regime) || b.effective_from.localeCompare(a.effective_from)).map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="py-1.5 text-xs">{REGIME[r.regime].replace("Micro-entrepreneur · ", "")}</td>
                <td className="text-xs">{r.kind === "social" ? "Cotisations sociales" : "Formation professionnelle"}</td>
                <td className="font-semibold">{formatRate(r.rate_milli)}</td>
                <td className="text-xs">{formatDate(r.effective_from)}</td>
                <td className="text-xs">
                  <Badge tone={r.origin === "official" ? "violet" : "neutral"}>{r.origin === "official" ? "Officiel, vérifié" : "Saisi par vous"}</Badge>
                  {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-semibold text-violet-strong">Source <ExternalLink size={11} /></a>}
                  {r.verified_on && <span className="block text-[11px] text-muted">vérifié le {formatDate(r.verified_on)}</span>}
                  {r.note && <span className="block text-[11px] text-muted">{r.note}</span>}
                </td>
                <td className="text-right">{r.origin === "user" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Supprimer ce taux ?") && act(() => deleteRateAction(r.id), "Taux supprimé")}>Supprimer</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="mt-3 grid gap-2 rounded-lg border border-line bg-surface/50 p-3 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => addRateAction(rate as Parameters<typeof addRateAction>[0]), "Taux ajouté", () => setRate({ ...rate, rate: "", source_url: "", note: "" }));
          }}
        >
          <Field label="Régime" className="sm:col-span-2"><Select value={rate.regime} onChange={(e) => setRate({ ...rate, regime: e.target.value })}>{Object.entries(REGIME).filter(([k]) => k !== "manual").map(([k, l]) => <option key={k} value={k}>{l.replace("Micro-entrepreneur · ", "")}</option>)}</Select></Field>
          <Field label="Type"><Select value={rate.kind} onChange={(e) => setRate({ ...rate, kind: e.target.value })}><option value="social">Cotisations</option><option value="cfp">Formation pro.</option></Select></Field>
          <Field label="Taux (%)"><Input required value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} placeholder="25,6" /></Field>
          <Field label="Date d'effet" className="sm:col-span-2"><Input type="date" required value={rate.effective_from} onChange={(e) => setRate({ ...rate, effective_from: e.target.value })} /></Field>
          <Field label="Source officielle (URL obligatoire)" className="sm:col-span-4"><Input type="url" required value={rate.source_url} onChange={(e) => setRate({ ...rate, source_url: e.target.value })} placeholder="https://www.urssaf.fr/…" /></Field>
          <div className="flex items-end sm:col-span-2"><Button type="submit" disabled={pending} className="w-full">Ajouter le taux</Button></div>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Solde de trésorerie d&apos;ouverture (facultatif)</h2>
        <p className="text-sm text-muted">Le solde de votre compte professionnel à une date. Sans lui, l&apos;application n&apos;affiche que la trésorerie de chaque période, jamais un solde.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Montant"><MoneyInput value={opening} onChange={setOpening} aria-label="Solde d'ouverture" /></Field>
          <Field label="À la date du (fin de journée)"><Input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} /></Field>
          <Button disabled={pending || opening == null} onClick={() => act(() => saveOpeningBalanceAction({ amount: opening!, as_of: openingDate }), "Solde d'ouverture enregistré")}>Enregistrer</Button>
          {data.opening && <Button variant="ghost" disabled={pending} onClick={() => act(() => saveOpeningBalanceAction(null), "Solde d'ouverture retiré")}>Retirer</Button>}
        </div>
        {data.opening && <p className="mt-1 text-xs text-muted">Actuel : {eur(data.opening.amount)} au {formatDate(data.opening.as_of)}.</p>}
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Catégories de charges</h2>
        <p className="text-sm text-muted">« Incluse dans l&apos;EBITDA » : la catégorie compte comme charge d&apos;exploitation dans le calculateur indicatif. Excluez par exemple les intérêts d&apos;emprunt.</p>
        <ul className="mt-2 divide-y divide-line">
          {data.categories.map((c) => <CategoryRow key={c.id} id={c.id} name={c.name} included={c.ebitda_included} />)}
        </ul>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); act(() => saveCategoryAction(null, { name: newCat, ebitda_included: true }), "Catégorie ajoutée", () => setNewCat("")); }}>
          <Input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Nouvelle catégorie" required />
          <Button type="submit" disabled={pending}>Ajouter</Button>
        </form>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Exports CSV</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {[["revenus", "Revenus"], ["paiements", "Paiements"], ["charges", "Charges"], ["urssaf", "Périodes URSSAF"]].map(([t, l]) => (
            <a key={t} href={`/api/finance/export?type=${t}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface"><Download size={14} /> {l}</a>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Sources officielles consultées</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          {OFFICIAL_SOURCES.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="font-semibold text-violet-strong">{s.label}</a>
              <span className="block text-xs text-muted">Vérifiée le {formatDate(s.verified)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Les taux et échéances évoluent : vérifiez-les sur autoentrepreneur.urssaf.fr avant chaque déclaration. L&apos;application ne déclare ni ne paie rien à votre place.</p>
      </Card>
    </div>
  );
}

function CategoryRow({ id, name, included }: { id: string; name: string; included: boolean }) {
  const { pending, act } = useAct();
  const [n, setN] = useState(name);
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <Input value={n} onChange={(e) => setN(e.target.value)} className="h-8 max-w-xs" aria-label="Nom de la catégorie" />
      {n !== name && <Button size="sm" disabled={pending || !n.trim()} onClick={() => act(() => saveCategoryAction(id, { name: n, ebitda_included: included }), "Catégorie renommée")}>Renommer</Button>}
      <label className="ml-auto flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={included} disabled={pending} onChange={(e) => act(() => saveCategoryAction(id, { name, ebitda_included: e.target.checked }), "Catégorie mise à jour")} />
        Incluse dans l&apos;EBITDA
      </label>
    </li>
  );
}
