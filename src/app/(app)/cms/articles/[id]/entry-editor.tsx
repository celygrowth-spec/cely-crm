"use client";

// Éditeur d'un article : contenu Markdown avec aperçu, image de couverture, classement, mots-clés, SEO (compteurs
// avec repères ~60 et ~155 caractères, valeurs pré-remplies affichées), publication (Paris), suppression.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { updateEntryAction } from "@/app/cms-actions";
import { TrashButton } from "@/components/trash/trash-button";
import { Badge, Button, Card, Field, Input, Textarea, cn } from "@/components/ui";
import { attempt } from "@/lib/client/query";
import { formatParis } from "@/lib/cms/dates";
import { slugify } from "@/lib/cms/slug";
import { EDITABLE_FIELDS, SEO_LIMITS, STATUS_LABEL, STATUS_TONE, effectiveStatus, readingMinutes, seoDefaults, type CmsDraft, type CmsEntry } from "@/lib/cms/types";
import { MarkdownField } from "@/components/cms/markdown-field";
import { ImageField } from "@/components/cms/image-field";
import { EntryExtras } from "@/components/cms/entry-extras";
import { PublishPanel } from "./publish-panel";

const pick = (e: CmsEntry): CmsDraft => Object.fromEntries(EDITABLE_FIELDS.map((k) => [k, e[k]])) as CmsDraft;
const listText = (a: string[]) => a.join(", ");
const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function EntryEditor({ entry }: { entry: CmsEntry }) {
  const router = useRouter();
  const [saved, setSaved] = useState<CmsDraft>(() => pick(entry));
  const [d, setD] = useState<CmsDraft>(() => pick(entry));
  const [tags, setTags] = useState(listText(entry.tags));
  const [kw, setKw] = useState(listText(entry.secondary_keywords));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current: CmsDraft = { ...d, tags: parseList(tags), secondary_keywords: parseList(kw) };
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const set = <K extends keyof CmsDraft>(k: K, v: CmsDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const status = effectiveStatus(entry);
  const defaults = seoDefaults(current);

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    setBusy(true);
    setError(null);
    const r = await attempt(() => updateEntryAction(entry.id, current));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    // la base normalise (espaces, tags en double) : l'éditeur reprend exactement la version enregistrée
    setSaved(pick(r.data));
    setD(pick(r.data));
    setTags(listText(r.data.tags));
    setKw(listText(r.data.secondary_keywords));
    toast.success("Article enregistré");
    router.refresh();
    return true;
  }

  // Ctrl/Cmd + S ; avertissement si on quitte avec des modifications non enregistrées
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); }
    };
    const onLeave = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onLeave); };
  });

  return (
    <div className="mx-auto max-w-6xl" data-cms-editor>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href="/cms" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink"><ArrowLeft size={14} /> Articles</Link>
        <Badge tone={STATUS_TONE[status]} className="ml-2" data-status={status}>{STATUS_LABEL[status]}</Badge>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && <span className="text-xs font-semibold text-amber-700" data-dirty>Modifications non enregistrées</span>}
          <EntryExtras entry={entry} />
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy} data-save>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
        </span>
      </div>
      {error && <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" data-error>{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card className="space-y-3 p-4">
            <Field label="Titre"><Input value={d.title} onChange={(e) => set("title", e.target.value)} maxLength={300} data-field="title" /></Field>
            <Field label="Slug" hint={status !== "draft" || entry.first_published_at ? "Article déjà publié : l'ancien slug deviendra une redirection 301." : undefined}>
              <div className="flex gap-2">
                <Input value={d.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} maxLength={120} data-field="slug" />
                <Button onClick={() => set("slug", slugify(d.title))} title="Recréer à partir du titre"><RefreshCw size={14} /> Depuis le titre</Button>
              </div>
            </Field>
            <Field label="Extrait"><Textarea rows={3} value={d.excerpt ?? ""} onChange={(e) => set("excerpt", e.target.value)} maxLength={1000} data-field="excerpt" /></Field>
            <MarkdownField value={d.body_md} onChange={(v) => set("body_md", v)} />
            <p className="text-xs text-muted">Temps de lecture : {readingMinutes(d.body_md)} min</p>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-display text-base font-bold">Image de couverture</h2>
            <ImageField label="Image" value={d.cover_image_url} onChange={(v) => set("cover_image_url", v)} field="cover_image_url" />
            <Field label="Texte alternatif"><Input value={d.cover_alt ?? ""} onChange={(e) => set("cover_alt", e.target.value)} maxLength={300} data-field="cover_alt" /></Field>
          </Card>

          <Card className="space-y-3 p-4" data-cms-seo>
            <h2 className="font-display text-base font-bold">SEO et partage</h2>
            <Counted label="Title tag" value={d.seo_title ?? ""} fallback={defaults.title} limit={SEO_LIMITS.title}>
              <Input value={d.seo_title ?? ""} placeholder={defaults.title} onChange={(e) => set("seo_title", e.target.value)} maxLength={200} data-field="seo_title" />
            </Counted>
            <Counted label="Meta description" value={d.seo_description ?? ""} fallback={defaults.description} limit={SEO_LIMITS.description}>
              <Textarea rows={3} value={d.seo_description ?? ""} placeholder={defaults.description} onChange={(e) => set("seo_description", e.target.value)} maxLength={400} data-field="seo_description" />
            </Counted>
            <Field label="Titre de partage" hint="Vide : le title tag"><Input value={d.og_title ?? ""} placeholder={defaults.ogTitle} onChange={(e) => set("og_title", e.target.value)} maxLength={200} data-field="og_title" /></Field>
            <ImageField label="Image de partage (vide : la couverture)" value={d.og_image_url} onChange={(v) => set("og_image_url", v)} field="og_image_url" />
            <Field label="URL canonique" hint="Vide : l'adresse de l'article"><Input value={d.canonical_url ?? ""} onChange={(e) => set("canonical_url", e.target.value)} placeholder="https://www.celygrowth.com/…" data-field="canonical_url" /></Field>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={d.noindex} onChange={(e) => set("noindex", e.target.checked)} data-field="noindex" /> Ne pas indexer
            </label>
          </Card>
        </div>

        <div className="space-y-4">
          <PublishPanel entry={entry} dirty={dirty} save={save} />
          <Card className="space-y-3 p-4">
            <h2 className="font-display text-base font-bold">Classement</h2>
            <Field label="Catégorie"><Input value={d.category ?? ""} onChange={(e) => set("category", e.target.value)} maxLength={100} data-field="category" /></Field>
            <Field label="Tags" hint="Séparés par des virgules"><Input value={tags} onChange={(e) => setTags(e.target.value)} data-field="tags" /></Field>
            <Field label="Auteur"><Input value={d.author ?? ""} onChange={(e) => set("author", e.target.value)} maxLength={120} data-field="author" /></Field>
          </Card>
          <Card className="space-y-3 p-4">
            <h2 className="font-display text-base font-bold">Mots-clés</h2>
            <Field label="Mot-clé cible"><Input value={d.focus_keyword ?? ""} onChange={(e) => set("focus_keyword", e.target.value)} maxLength={120} data-field="focus_keyword" /></Field>
            <Field label="Mots-clés secondaires" hint="Séparés par des virgules"><Input value={kw} onChange={(e) => setKw(e.target.value)} data-field="secondary_keywords" /></Field>
          </Card>
          <Card className="space-y-1 p-4 text-xs text-muted">
            <p>Mise à jour du contenu : {formatParis(entry.content_updated_at)}</p>
            <p>Première publication : {formatParis(entry.first_published_at)}</p>
            <p>Temps de lecture enregistré : {entry.reading_minutes} min</p>
          </Card>
          <TrashButton kind="cms_entry" id={entry.id} variant="danger" size="md" className="w-full" onDone={() => router.push("/cms")}>Supprimer l&apos;article</TrashButton>
        </div>
      </div>
    </div>
  );
}

/** Champ SEO avec compteur : la valeur saisie, ou la valeur pré-remplie si le champ est vide. */
function Counted({ label, value, fallback, limit, children }: { label: string; value: string; fallback: string; limit: number; children: ReactNode }) {
  const n = (value.trim() || fallback).length;
  const over = n > limit + 5, under = n < limit * 0.5;
  return (
    <div>
      {/* le libellé est porté par le champ enfant via son placeholder ; le compteur indique la longueur effective */}
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-label text-xs font-semibold text-muted">{label}</span>
        <span className={cn("text-xs tabular-nums", over ? "font-bold text-danger" : under ? "text-amber-700" : "text-emerald-700")} data-counter={label}>
          {n} / ~{limit}{!value.trim() && fallback ? " (pré-rempli)" : ""}
        </span>
      </div>
      {children}
    </div>
  );
}
