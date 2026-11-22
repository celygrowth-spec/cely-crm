"use client";

// Pages SEO : un champ vide laisse au site la valeur de son code (affichée en grisé quand l'import l'a fournie).
// Import en lot depuis le fichier JSON « cely-cms-pages » produit par le site.
import { useRouter } from "next/navigation";
import { ChevronDown, FileJson, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { deletePageAction, importPagesAction, savePageAction } from "@/app/cms-actions";
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Textarea, cn } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import type { CmsPage } from "@/lib/cms/pages";
import { SEO_LIMITS } from "@/lib/cms/types";

type Form = { path: string; label: string; seo_title: string; seo_description: string; og_title: string; og_image_url: string; canonical_url: string; noindex: "" | "true" | "false" };
const toForm = (p: CmsPage | null): Form => ({
  path: p?.path ?? "", label: p?.label ?? "", seo_title: p?.seo_title ?? "", seo_description: p?.seo_description ?? "", og_title: p?.og_title ?? "",
  og_image_url: p?.og_image_url ?? "", canonical_url: p?.canonical_url ?? "", noindex: p?.noindex === null || !p ? "" : p.noindex ? "true" : "false",
});
const overrides = (p: CmsPage) => [p.seo_title, p.seo_description, p.og_title, p.og_image_url, p.canonical_url, p.noindex].filter((v) => v !== null).length;

export function PagesView({ pages }: { pages: CmsPage[] }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [report, setReport] = useState<{ created: number; updated: number; unchanged: number; errors: string[] } | null>(null);

  async function importFile(f: File) {
    const r = await attempt(async () => importPagesAction(await f.text()));
    if (!r.ok) return toast.error(r.error);
    setReport(r.data);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-5xl" data-cms-pages>
      <PageHeader title="Pages SEO" description="Title, description, partage, canonique et indexation des pages du site. Un champ vide : le site garde la valeur de son code."
        actions={<div className="flex gap-2">
          <Button onClick={() => file.current?.click()} data-pages-import><FileJson size={15} /> Importer le JSON du site</Button>
          <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Ajouter une page</Button>
        </div>} />
      <input ref={file} type="file" accept="application/json,.json" className="hidden" data-pages-import-input
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
      {!pages.length ? <EmptyState title="Aucune page" description="Importez le fichier JSON fourni par le site, ou ajoutez une page par son chemin (ex. /offres)." /> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">
          {pages.map((p) => (
            <li key={p.id} data-page={p.path}>
              <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-violet-soft/30" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                <span className="min-w-0 flex-1"><span className="font-mono font-semibold">{p.path}</span>{p.label && <span className="text-muted"> · {p.label}</span>}</span>
                {overrides(p) > 0 ? <Badge tone="success">{overrides(p)} réglage(s)</Badge> : <Badge>Valeurs du site</Badge>}
                {p.noindex === true && <Badge tone="danger">Ne pas indexer</Badge>}
                <ChevronDown size={15} className={cn("shrink-0 transition-transform", open === p.id && "rotate-180")} />
              </button>
              {open === p.id && <PageForm page={p} onDone={() => router.refresh()} />}
            </li>
          ))}
        </ul>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Ajouter une page" wide>
        <PageForm page={null} onDone={() => { setAdding(false); router.refresh(); }} />
      </Modal>
      <Modal open={!!report} onClose={() => setReport(null)} title="Import des pages">
        {report && (
          <div className="space-y-2 text-sm" data-pages-report>
            <p>{report.created} page(s) créée(s), {report.updated} mise(s) à jour, {report.unchanged} inchangée(s). Vos réglages n&apos;ont pas été modifiés.</p>
            {report.errors.map((e) => <p key={e} className="text-danger">{e}</p>)}
            <div className="flex justify-end"><Button onClick={() => setReport(null)}>Fermer</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function PageForm({ page, onDone }: { page: CmsPage | null; onDone: () => void }) {
  const [f, setF] = useState<Form>(() => toForm(page));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = page?.site_defaults ?? {};
  const set = (k: keyof Form, v: string) => setF((x) => ({ ...x, [k]: v }));
  const count = (v: string, fallback: string | null | undefined, limit: number) => {
    const n = (v.trim() || fallback || "").length;
    return <span className={cn("text-xs tabular-nums", n > limit + 5 ? "font-bold text-danger" : "text-muted")}>{n} / ~{limit}{!v.trim() && fallback ? " (site)" : ""}</span>;
  };

  async function save() {
    setBusy(true);
    setError(null);
    const r = await attempt(() => savePageAction(page?.id ?? null, { ...f, noindex: f.noindex === "" ? null : f.noindex === "true" }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success("Page enregistrée");
    onDone();
  }
  async function remove() {
    if (!page || !confirm(`Retirer ${page.path} du CMS ? Le site reprendra les valeurs de son code.`)) return;
    const r = await attempt(() => deletePageAction(page.id));
    if (!r.ok) return toast.error(r.error);
    onDone();
  }
  return (
    <div className="grid gap-3 border-t border-line bg-surface/40 p-3 sm:grid-cols-2" data-page-form>
      <Field label="Chemin"><Input value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="/offres" disabled={!!page} data-field="path" /></Field>
      <Field label="Nom (pour vous)"><Input value={f.label} onChange={(e) => set("label", e.target.value)} data-field="label" /></Field>
      <div className="sm:col-span-2">
        <div className="mb-1 flex justify-between"><span className="font-label text-xs font-semibold text-muted">Title tag</span>{count(f.seo_title, d.title, SEO_LIMITS.title)}</div>
        <Input value={f.seo_title} placeholder={d.title ?? "Vide : valeur du site"} onChange={(e) => set("seo_title", e.target.value)} data-field="seo_title" />
      </div>
      <div className="sm:col-span-2">
        <div className="mb-1 flex justify-between"><span className="font-label text-xs font-semibold text-muted">Meta description</span>{count(f.seo_description, d.description, SEO_LIMITS.description)}</div>
        <Textarea rows={2} value={f.seo_description} placeholder={d.description ?? "Vide : valeur du site"} onChange={(e) => set("seo_description", e.target.value)} data-field="seo_description" />
      </div>
      <Field label="Titre de partage"><Input value={f.og_title} placeholder={d.og_title ?? "Vide : valeur du site"} onChange={(e) => set("og_title", e.target.value)} data-field="og_title" /></Field>
      <Field label="Image de partage (adresse)"><Input value={f.og_image_url} placeholder={d.og_image ?? "Vide : valeur du site"} onChange={(e) => set("og_image_url", e.target.value)} data-field="og_image_url" /></Field>
      <Field label="URL canonique"><Input value={f.canonical_url} placeholder={d.canonical ?? "Vide : valeur du site"} onChange={(e) => set("canonical_url", e.target.value)} data-field="canonical_url" /></Field>
      <Field label="Indexation">
        <Select value={f.noindex} onChange={(e) => set("noindex", e.target.value)} data-field="noindex">
          <option value="">Valeur du site{d.noindex === true ? " (ne pas indexer)" : d.noindex === false ? " (indexer)" : ""}</option>
          <option value="false">Indexer</option>
          <option value="true">Ne pas indexer</option>
        </Select>
      </Field>
      {error && <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        {page && <Button variant="danger" onClick={() => void remove()}><Trash2 size={14} /> Retirer</Button>}
        <Button variant="primary" onClick={() => void save()} disabled={busy} data-page-save>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
      </div>
    </div>
  );
}
