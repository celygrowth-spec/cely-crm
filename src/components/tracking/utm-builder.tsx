"use client";

// Générateur de liens UTM : une page du site, une source, un support, une campagne → un lien à copier.
// La convention de nommage est imposée (minuscules, sans accents, tirets) : la saisie est normalisée sous les yeux
// de l'utilisateur, qui voit toujours le lien exact avant de le copier. Chaque lien créé est enregistré avec son nom.
import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { toast } from "sonner";
import { saveUtmLinkAction } from "@/app/tracking-actions";
import { UTM_MEDIUMS, UTM_SOURCES, buildUtmUrl, canonicalUtmValue, slugUtm } from "@/lib/tracking/utm";

const label = "mb-1 block text-xs font-semibold text-muted";

export function UtmBuilder({ pages, campaigns }: { pages: string[]; campaigns: string[] }) {
  const id = useId();
  const qc = useQueryClient();
  const [path, setPath] = useState("/");
  const [source, setSource] = useState("linkedin");
  const [medium, setMedium] = useState("post");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const norm = useMemo(() => ({ source: canonicalUtmValue(source), medium: canonicalUtmValue(medium), campaign: slugUtm(campaign), content: slugUtm(content) }), [source, medium, campaign, content]);
  const ready = !!(norm.source && norm.medium && norm.campaign && path.trim());
  const url = useMemo(() => {
    try {
      return buildUtmUrl(path.trim() || "/", { utm_source: norm.source, utm_medium: norm.medium, utm_campaign: norm.campaign, utm_content: norm.content || undefined });
    } catch {
      return "";
    }
  }, [path, norm]);
  // ce que la convention a changé dans la saisie, pour que rien ne soit modifié en silence
  const fixes = ([["source", source, norm.source], ["support", medium, norm.medium], ["campagne", campaign, norm.campaign], ["contenu", content, norm.content]] as const)
    .filter(([, raw, n]) => raw.trim() && raw.trim() !== n);

  async function save(copy: boolean) {
    if (!ready || busy) return;
    setBusy(true);
    const r = await saveUtmLinkAction({ name: name.trim() || `${norm.source} · ${norm.campaign}`, path: path.trim(), source, medium, campaign, content: content || undefined });
    setBusy(false);
    if (!r.ok) { toast.error(r.error); return; }
    if (copy) {
      try {
        await navigator.clipboard.writeText(r.data.url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success("Lien copié et enregistré.");
      } catch {
        toast.message("Lien enregistré. Copie-le depuis la liste ci-dessous.");
      }
    } else {
      toast.success("Lien enregistré.");
    }
    await qc.invalidateQueries({ queryKey: ["tracking"] });
  }

  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void save(true); }} data-utm-builder>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-1">
          <label htmlFor={`${id}-p`} className={label}>Page du site</label>
          <input id={`${id}-p`} className="trk-field w-full" list={`${id}-pages`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/services" required />
          <datalist id={`${id}-pages`}>{pages.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
        <div>
          <label htmlFor={`${id}-s`} className={label}>Source</label>
          <input id={`${id}-s`} className="trk-field w-full" list={`${id}-sources`} value={source} onChange={(e) => setSource(e.target.value)} required />
          <datalist id={`${id}-sources`}>{UTM_SOURCES.map((v) => <option key={v} value={v} />)}</datalist>
        </div>
        <div>
          <label htmlFor={`${id}-m`} className={label}>Support</label>
          <input id={`${id}-m`} className="trk-field w-full" list={`${id}-mediums`} value={medium} onChange={(e) => setMedium(e.target.value)} required />
          <datalist id={`${id}-mediums`}>{UTM_MEDIUMS.map((v) => <option key={v} value={v} />)}</datalist>
        </div>
        <div>
          <label htmlFor={`${id}-c`} className={label}>Campagne</label>
          <input id={`${id}-c`} className="trk-field w-full" list={`${id}-campaigns`} value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="lancement-offre" required />
          <datalist id={`${id}-campaigns`}>{campaigns.map((v) => <option key={v} value={v} />)}</datalist>
        </div>
        <div>
          <label htmlFor={`${id}-t`} className={label}>Contenu <span className="font-normal">(facultatif)</span></label>
          <input id={`${id}-t`} className="trk-field w-full" value={content} onChange={(e) => setContent(e.target.value)} placeholder="bouton-haut" />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-n`} className={label}>Nom lisible du lien</label>
        <input id={`${id}-n`} className="trk-field w-full" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={ready ? `${norm.source} · ${norm.campaign}` : "Post LinkedIn du 12 novembre"} />
      </div>
      {fixes.length > 0 && (
        <p className="text-xs text-muted" role="status">
          Convention appliquée (minuscules, sans accents, tirets) : {fixes.map(([k, raw, n]) => `${k} « ${raw.trim()} » → ${n || "vide"}`).join(" · ")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Link2 size={15} className="shrink-0 text-muted" aria-hidden />
        <code className="min-w-0 flex-1 text-xs break-all text-ink" data-utm-url>{ready ? url : "Renseigne la source, le support et la campagne pour obtenir le lien."}</code>
        <button type="submit" disabled={!ready || busy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-ink px-3 text-[13px] font-semibold text-[var(--background)] disabled:opacity-50">
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Copié" : "Copier le lien"}
        </button>
        <button type="button" disabled={!ready || busy} onClick={() => void save(false)} className="h-9 shrink-0 rounded-[10px] border border-line px-3 text-[13px] font-semibold text-ink hover:border-violet disabled:opacity-50">
          Enregistrer
        </button>
      </div>
    </form>
  );
}
