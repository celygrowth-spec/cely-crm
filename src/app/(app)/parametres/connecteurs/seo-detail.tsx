"use client";

// Détail de Search Console et de Bing Webmaster Tools : choix du site suivi, clé API Bing, synchronisation.
// La clé Bing se saisit ici mais n'est jamais réaffichée : elle n'existe en clair que sur le serveur.
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button, Input, Select, Spinner } from "@/components/ui";
import type { Connector } from "@/lib/connectors/types";
import { connectBingAction, setSeoSiteAction, syncSeoAction } from "@/lib/tracking/seo/actions";
import type { SeoDetail as Detail } from "@/lib/tracking/seo/rules";

const OAUTH_ERRORS: Record<string, string> = {
  config: "Search Console n'est pas configuré sur le serveur (identifiants Google ou secret serveur absents).",
  refus: "Connexion annulée : vous avez refusé l'accès chez Google.",
  etat: "Connexion interrompue (session expirée) : recommencez.",
  permissions: "Google n'a pas accordé la lecture de Search Console : recommencez en cochant l'autorisation.",
  "hors-ligne": "Google n'a pas fourni d'accès durable : recommencez la connexion.",
  "aucun-site": "Ce compte Google ne voit aucune propriété Search Console vérifiée.",
  enregistrement: "La connexion n'a pas pu être enregistrée.",
  google: "Google n'a pas terminé la connexion : réessayez.",
};
/** Garde-fou de la relance automatique : au-delà, le passage quotidien termine l'import. */
const MAX_ROUNDS = 60;

export function SeoDetail({ detail, onUpdated }: { detail: Detail; onUpdated: (c: Connector) => void }) {
  const [pending, start] = useTransition();
  const [progress, setProgress] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [site, setSite] = useState(detail.siteUrl ?? "");
  const stop = useRef(false);
  const gsc = detail.provider === "gsc";

  // retour de la connexion Google : un message, une seule fois
  useEffect(() => {
    if (!gsc) return;
    const url = new URL(window.location.href);
    const err = url.searchParams.get("seo_erreur");
    const ok = url.searchParams.get("seo");
    if (!err && !ok) return;
    if (err) toast.error(OAUTH_ERRORS[err] ?? OAUTH_ERRORS.google);
    else toast.success("Search Console connecté en lecture seule.");
    url.searchParams.delete("seo_erreur");
    url.searchParams.delete("seo");
    window.history.replaceState(null, "", url.toString());
  }, [gsc]);
  useEffect(() => () => { stop.current = true; }, []);

  const sync = () => {
    stop.current = false;
    start(async () => {
      for (let round = 0; round < MAX_ROUNDS && !stop.current; round++) {
        const r = await syncSeoAction(detail.provider);
        if (!r.ok) { setProgress(null); return void toast.error(r.error); }
        if (r.data.connector) onUpdated(r.data.connector);
        if (!r.data.ok) { setProgress(null); return void toast.error(r.data.message); }
        if (r.data.done) { setProgress(null); return void toast.success(r.data.message); }
        setProgress(r.data.message);
      }
      setProgress(null);
      toast.message("Import en cours : il se poursuivra au prochain passage planifié.");
    });
  };
  const chooseSite = (value: string) => {
    if (!value || value === detail.siteUrl) return;
    if (detail.siteUrl && !confirm(`Suivre « ${value} » à la place de « ${detail.siteUrl} » ?\n\nLes chiffres déjà importés de l'ancienne propriété sont effacés du CRM et l'import repart de zéro.`)) return void setSite(detail.siteUrl);
    setSite(value);
    start(async () => {
      const r = await setSeoSiteAction(detail.provider, value);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.connector) onUpdated(r.data.connector);
      toast.success("Site suivi enregistré. Lancez la synchronisation pour importer l'historique.");
    });
  };
  const connectBing = () => {
    start(async () => {
      const r = await connectBingAction({ apiKey, siteUrl: site });
      if (!r.ok) return void toast.error(r.error);
      setApiKey("");
      if (r.data.connector) onUpdated(r.data.connector);
      toast.success(r.data.message);
    });
  };

  return (
    <section className="mt-5" data-seo={detail.provider}>
      <h3 className="mb-1.5 font-label text-[11px] font-bold tracking-wide text-muted uppercase">{gsc ? "Propriété suivie" : "Connexion"}</h3>

      {gsc && detail.connected && (
        detail.sites.length > 0 ? (
          <Select aria-label="Propriété Search Console suivie" value={site} disabled={pending} onChange={(e) => chooseSite(e.target.value)}>
            {!detail.siteUrl && <option value="">Choisir une propriété…</option>}
            {detail.sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        ) : <p className="text-sm text-muted">Aucune propriété proposée : reconnectez Search Console.</p>
      )}
      {gsc && !detail.connected && (
        <p className="text-sm text-muted">{detail.configured ? "Connectez votre compte Google : le CRM ne demande que la lecture des statistiques de recherche." : "Ajoutez d'abord les identifiants Google sur le serveur (voir « Paramètres » ci-dessous)."}</p>
      )}

      {!gsc && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); connectBing(); }}>
          {detail.connected && <p className="text-sm text-muted">Clé enregistrée, masquée. Pour la remplacer, collez la nouvelle clé.</p>}
          <Input type="password" autoComplete="off" aria-label="Clé API Bing Webmaster Tools" placeholder="Clé API (Bing Webmaster Tools › Paramètres › Accès API)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <Input type="url" aria-label="Adresse du site dans Bing" placeholder="https://celygrowth.com/" value={site} onChange={(e) => setSite(e.target.value)} />
          <Button type="submit" variant="primary" disabled={pending || !detail.configured || apiKey.trim().length < 16}>{pending && !progress ? <Spinner /> : null} {detail.connected ? "Remplacer la clé" : "Connecter Bing"}</Button>
          {!detail.configured && <p className="text-xs text-warning">Secret serveur absent (APPOINTMENTS_SECRET) : la clé ne peut pas être protégée.</p>}
        </form>
      )}

      {detail.connected && detail.siteUrl && (
        <div className="mt-3">
          <Button disabled={pending} onClick={sync}>{pending ? <Spinner /> : <RefreshCw size={14} />} Synchroniser maintenant</Button>
          <p className="mt-1.5 text-xs text-muted" aria-live="polite">
            {progress ?? (detail.historyDone ? "Historique importé ; les derniers jours sont relus à chaque passage quotidien." : "L'historique s'importe par lots : ce bouton enchaîne les lots, le passage quotidien reprend là où l'import s'est arrêté.")}
          </p>
        </div>
      )}
    </section>
  );
}
