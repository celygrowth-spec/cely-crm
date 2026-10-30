"use client";

import Papa from "papaparse";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { importCheckAction, importCommitAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, Card, Field, PageHeader, Select, Spinner, cn } from "@/components/ui";
import { buildRows, groupRows, guessMapping, IMPORT_FIELDS, type ImportGroup, type ImportRow, type Mapping } from "@/lib/crm/import";
import { normEmail } from "@/lib/crm/normalize";

type Candidate = { company_id: string; name: string; website: string | null; strength: "exact" | "similar"; reasons: string[] };
type Decision = { action: "create" | "complete" | "skip" | ""; target?: string };
type Checked = { candidates: Candidate[]; already: string[] };
type Summary = { created: number; completed: number; skipped: number; people: number; replayed?: boolean; errors: { rows: number[]; message: string }[] };

export function ImportWizard() {
  const { lists } = useCrm();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [records, setRecords] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [groupByCompany, setGroupByCompany] = useState(true);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [groups, setGroups] = useState<ImportGroup[]>([]);
  const [checked, setChecked] = useState<Record<string, Checked>>({});
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [listId, setListId] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [importKey, setImportKey] = useState("");

  function onFile(file: File) {
    setFilename(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (res) => {
        if (res.errors.length && !res.data.length) return toast.error(`Fichier illisible : ${res.errors[0].message}`);
        if (res.data.length > 10000) return toast.error("10 000 lignes maximum par import.");
        const h = res.meta.fields ?? [];
        setHeaders(h);
        setRecords(res.data);
        setMapping(guessMapping(h));
        setStep(2);
      },
      error: (e) => toast.error(`Lecture impossible : ${e.message}`),
    });
  }

  async function preview() {
    if (!mapping.company) return toast.error("Associez au moins la colonne Entreprise.");
    setBusy(true);
    const r = await buildRows(records, mapping);
    const g = groupRows(r, groupByCompany);
    setRows(r);
    setGroups(g);
    const res = await importCheckAction(
      g.map((x) => ({
        key: x.key,
        name: x.company.name,
        website: x.company.website,
        emails: x.people.map((p) => p.email).filter(Boolean) as string[],
        linkedins: x.people.map((p) => p.linkedin_url).filter(Boolean) as string[],
        person_names: x.people.map((p) => `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()).filter(Boolean),
        row_hashes: x.rows.map((row) => row.hash),
      })),
    );
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    const c: Record<string, Checked> = {};
    const d: Record<string, Decision> = {};
    for (const item of res.data) {
      c[item.key] = { candidates: item.candidates, already: item.already_imported_company_ids };
      const exact = item.candidates.find((x) => x.strength === "exact");
      if (item.already_imported_company_ids.length) d[item.key] = { action: "skip" };
      else if (exact) d[item.key] = { action: "complete", target: exact.company_id };
      else if (item.candidates.length) d[item.key] = { action: "" }; // ressemblance : décision explicite requise
      else d[item.key] = { action: "create" };
    }
    setChecked(c);
    setDecisions(d);
    setImportKey(crypto.randomUUID());
    setStep(3);
  }

  // emails présents dans plusieurs groupes du fichier (si le regroupement est désactivé)
  const fileDupEmails = useMemo(() => {
    const seen = new Map<string, number>();
    groups.forEach((g) => new Set(g.people.map((p) => normEmail(p.email)).filter(Boolean)).forEach((e) => seen.set(e!, (seen.get(e!) ?? 0) + 1)));
    return new Set([...seen].filter(([, n]) => n > 1).map(([e]) => e));
  }, [groups]);

  const undecided = groups.filter((g) => !decisions[g.key]?.action).length;
  const errorRows = rows.filter((r) => r.error);
  const counts = { create: 0, complete: 0, skip: 0 };
  groups.forEach((g) => { const a = decisions[g.key]?.action; if (a) counts[a]++; });

  async function commit() {
    setBusy(true);
    const payload = groups.map((g) => ({
      key: g.key,
      action: decisions[g.key].action,
      target_company_id: decisions[g.key].target ?? null,
      rows: g.rows.map((r) => r.line),
      row_hashes: g.rows.map((r) => r.hash),
      company: g.company,
      people: g.people,
    }));
    const res = await importCommitAction(importKey, filename, payload, listId || null);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setSummary(res.data);
    setStep(4);
  }

  const setAll = (action: Decision["action"], filter: (g: ImportGroup) => boolean) =>
    setDecisions((d) => {
      const n = { ...d };
      groups.filter(filter).forEach((g) => {
        const exact = checked[g.key]?.candidates.find((c) => c.strength === "exact") ?? checked[g.key]?.candidates[0];
        if (action === "complete" && !exact) return;
        n[g.key] = { action, target: action === "complete" ? exact!.company_id : undefined };
      });
      return n;
    });

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Import et export CSV"
        actions={
          <>
            <a href="/api/export?type=companies" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-violet-soft"><Download size={14} /> Entreprises</a>
            <a href="/api/export?type=people" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-violet-soft"><Download size={14} /> Personnes</a>
            <a href="/api/export?type=interactions" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold hover:bg-violet-soft"><Download size={14} /> Historique</a>
          </>
        }
      />
      <ol className="mb-5 flex flex-wrap gap-2 font-label text-xs font-semibold">
        {["Fichier", "Colonnes", "Vérification", "Résultat"].map((l, i) => (
          <li key={l} className={cn("rounded-full px-3 py-1", step === i + 1 ? "bg-ink text-white" : step > i + 1 ? "bg-violet-soft text-ink" : "bg-surface text-muted")}>
            {i + 1}. {l}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card className="p-6">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center hover:border-violet">
            <Upload className="text-violet" />
            <span className="font-semibold">Choisir un fichier CSV</span>
            <span className="text-xs text-muted">Colonnes reconnues : entreprise, site web, prénom, nom, email, téléphone, LinkedIn, source, poste, description.</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
        </Card>
      )}

      {step === 2 && (
        <Card className="p-4">
          <p className="mb-3 text-sm text-muted">{filename} · {records.length} ligne(s). Associez les colonnes du fichier.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {IMPORT_FIELDS.map((f) => (
              <Field key={f.key} label={`${f.label}${"required" in f && f.required ? " *" : ""}`}>
                <Select value={mapping[f.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}>
                  <option value="">— Ignorer —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={groupByCompany} onChange={(e) => setGroupByCompany(e.target.checked)} />
            Rattacher à une même fiche les personnes d&apos;une même entreprise (même domaine ou même nom)
          </label>
          <div className="mt-4 flex justify-between">
            <Button onClick={() => setStep(1)}>Retour</Button>
            <Button variant="primary" onClick={preview} disabled={busy}>{busy ? <Spinner /> : "Vérifier les doublons"}</Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <Card className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span><strong>{groups.length}</strong> entreprise(s) · <strong>{rows.length - errorRows.length}</strong> ligne(s) valide(s)</span>
            <Badge tone="success">Créer : {counts.create}</Badge>
            <Badge tone="violet">Compléter : {counts.complete}</Badge>
            <Badge>Exclure : {counts.skip}</Badge>
            {undecided > 0 && <Badge tone="warning">À décider : {undecided}</Badge>}
            <div className="ml-auto flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAll("create", (g) => !checked[g.key]?.candidates.length)}>Créer les nouvelles</Button>
              <Button size="sm" variant="ghost" onClick={() => setAll("skip", (g) => !decisions[g.key]?.action)}>Exclure les indécises</Button>
            </div>
          </Card>
          {errorRows.length > 0 && (
            <Card className="border-danger/30 p-3 text-sm">
              <p className="font-semibold text-danger">{errorRows.length} ligne(s) ignorée(s)</p>
              <ul className="mt-1 text-xs text-muted">{errorRows.slice(0, 20).map((r) => <li key={r.line}>Ligne {r.line} : {r.error}</li>)}</ul>
            </Card>
          )}
          <div className="divide-y divide-line rounded-xl border border-line">
            {groups.map((g) => {
              const c = checked[g.key];
              const d = decisions[g.key] ?? { action: "" };
              const dupEmail = g.people.some((p) => p.email && fileDupEmails.has(normEmail(p.email)!));
              return (
                <div key={g.key} className={cn("grid gap-2 p-3 md:grid-cols-[1fr_auto]", !d.action && "bg-amber-50/50")}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {g.company.name}
                      {g.company.website && <span className="font-normal text-muted">{g.company.website}</span>}
                      <span className="text-xs font-normal text-muted">lignes {g.rows.map((r) => r.line).join(", ")}</span>
                      {c?.already.length ? <Badge>Déjà importée</Badge> : null}
                      {g.inFileDuplicates > 0 && <Badge tone="warning">{g.inFileDuplicates} doublon(s) dans le fichier fusionné(s)</Badge>}
                      {dupEmail && <Badge tone="warning">Email présent sur plusieurs lignes</Badge>}
                    </p>
                    <p className="text-xs text-muted">{g.people.map((p) => `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || p.email).join(", ") || "Aucune personne"}</p>
                    {c?.candidates.map((x) => (
                      <p key={x.company_id} className="mt-1 text-xs">
                        <Badge tone={x.strength === "exact" ? "danger" : "warning"}>{x.strength === "exact" ? "Existe" : "Ressemble"}</Badge> {x.name} — {x.reasons.join(" · ")}
                      </p>
                    ))}
                  </div>
                  <Select
                    value={d.action === "complete" ? `complete:${d.target}` : d.action}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDecisions({ ...decisions, [g.key]: v.startsWith("complete:") ? { action: "complete", target: v.slice(9) } : { action: v as Decision["action"] } });
                    }}
                    className={cn("w-full md:w-64", !d.action && "border-warning")}
                    aria-label={`Action pour ${g.company.name}`}
                  >
                    <option value="">— Choisir —</option>
                    <option value="create">Créer une nouvelle fiche</option>
                    {c?.candidates.map((x) => <option key={x.company_id} value={`complete:${x.company_id}`}>Compléter « {x.name} »</option>)}
                    <option value="skip">Exclure</option>
                  </Select>
                </div>
              );
            })}
          </div>
          <Card className="flex flex-wrap items-end justify-between gap-3 p-3">
            <Field label="Ajouter les fiches importées à une liste (facultatif)">
              <Select value={listId} onChange={(e) => setListId(e.target.value)} className="w-64">
                <option value="">—</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => setStep(2)}>Retour</Button>
              <Button variant="primary" onClick={commit} disabled={busy || undecided > 0}>
                {busy ? <Spinner /> : undecided > 0 ? `${undecided} décision(s) manquante(s)` : "Lancer l'import"}
              </Button>
            </div>
          </Card>
          <p className="text-xs text-muted">Compléter une fiche ajoute les personnes manquantes et remplit les champs vides, sans jamais écraser une valeur existante.</p>
        </div>
      )}

      {step === 4 && summary && (
        <Card className="p-5">
          <h2 className="font-display text-lg font-bold">{summary.replayed ? "Cet import avait déjà été exécuté" : "Import terminé"}</h2>
          <ul className="mt-2 text-sm">
            <li>{summary.created} fiche(s) créée(s)</li>
            <li>{summary.completed} fiche(s) complétée(s)</li>
            <li>{summary.skipped} exclue(s)</li>
            <li>{summary.people} personne(s) ajoutée(s)</li>
            {errorRows.length > 0 && <li>{errorRows.length} ligne(s) ignorée(s) avant import</li>}
          </ul>
          {summary.errors.length > 0 && (
            <div className="mt-3 rounded-lg bg-danger/5 p-3 text-sm">
              <p className="font-semibold text-danger">{summary.errors.length} erreur(s) : ces lignes n&apos;ont pas été importées</p>
              <ul className="mt-1 text-xs">{summary.errors.map((e, i) => <li key={i}>Ligne(s) {e.rows.join(", ")} : {e.message}</li>)}</ul>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => { setStep(1); setSummary(null); }}>Nouvel import</Button>
            <a href="/prospection/base" className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm font-semibold">Voir la base</a>
          </div>
        </Card>
      )}
    </div>
  );
}
