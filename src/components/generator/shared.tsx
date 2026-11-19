"use client";

// Briques d'écran communes au diagnostic et aux générateurs (proposition, onboarding) : appel d'une route d'écriture,
// lien vers Claude avec message prêt, ouverture et téléchargement d'un fichier de la fiche.
import { toast } from "sonner";
import { Copy, ExternalLink } from "lucide-react";
import { attempt } from "@/lib/client/query";
import { claudeLink } from "@/lib/crm/diagnostic-rules";
import { Button } from "../ui";

export const post = <T,>(url: string, body: Record<string, unknown>) =>
  attempt(async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: true; data: T } | { ok: false; error: string };
  });

/** Ouvre Claude et garde le message sous la main si le lien ne remplit pas la case. */
export function ClaudeActions({ prompt, chatUrl, label }: { prompt: string; chatUrl: string | null; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={claudeLink(prompt, chatUrl)} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-sm font-semibold text-white hover:bg-violet-strong">
        <ExternalLink size={14} /> {label}
      </a>
      <Button onClick={async () => { await navigator.clipboard.writeText(prompt); toast.success("Message copié"); }}><Copy size={14} /> Copier le message</Button>
      <p className="w-full text-xs text-muted">Dans Claude, appuyez sur Entrée pour envoyer. Si la case reste vide, collez le message copié.</p>
    </div>
  );
}

export async function downloadFile(fileId: string) {
  const r = await post<string>("/api/files", { op: "url", id: fileId, download: true });
  if (!r.ok) return void toast.error(r.error);
  window.location.assign(r.data);
}

/** Affiche le fichier dans un nouvel onglet (un PDF s'ouvre dans le navigateur ; un autre format se télécharge). */
export async function openFile(fileId: string) {
  // onglet ouvert pendant le clic : un onglet ouvert après l'attente du lien serait bloqué par le navigateur
  const tab = window.open("", "_blank");
  const r = await post<string>("/api/files", { op: "url", id: fileId, download: false });
  if (!r.ok) {
    tab?.close();
    return void toast.error(r.error);
  }
  if (!tab) return window.location.assign(r.data);
  tab.opener = null;
  tab.location.href = r.data;
}
