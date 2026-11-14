"use client";

// Panneau « Intégrer » : codes à coller sur un autre site pour réserver sans quitter la page.
// Les aperçus affichent la vraie page de réservation intégrable (/rdv/<lien>/integre).
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, X } from "lucide-react";
import { Button, Field, Input, Modal, cn } from "@/components/ui";
import { DEFAULT_BUTTON_TEXT, EMBED_PATH, MAX_BUTTON_TEXT, cleanButtonText, embedCode, type EmbedKind } from "@/lib/appointments/embed";

type Format = "inline" | "floating" | "trigger";

const FORMATS: { id: Format; label: string; help: string }[] = [
  { id: "inline", label: "Dans la page", help: "Le calendrier s'affiche à l'endroit où vous collez le code. Sa hauteur s'adapte au contenu." },
  { id: "floating", label: "Bouton flottant", help: "Un bouton fixe en bas à droite de l'écran ouvre la réservation dans une fenêtre par-dessus le site." },
  { id: "trigger", label: "Lien ou bouton", help: "Un bouton ou un lien placé où vous voulez ouvre la même fenêtre." },
];

export function EmbedDialog({ open, onClose, name, slug, active, baseUrl }: {
  open: boolean; onClose: () => void; name: string; slug: string; active: boolean; baseUrl: string;
}) {
  const [format, setFormat] = useState<Format>("inline");
  const [triggerStyle, setTriggerStyle] = useState<"button" | "popup">("button");
  const [text, setText] = useState(DEFAULT_BUTTON_TEXT);
  const [copied, setCopied] = useState(false);
  const [popup, setPopup] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);

  const kind: EmbedKind = format === "trigger" ? triggerStyle : format;
  const code = useMemo(() => embedCode(kind, { baseUrl, slug, text }), [kind, baseUrl, slug, text]);
  const label = cleanButtonText(text);
  const current = FORMATS.find((f) => f.id === format)!;

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Code copié");
    } catch {
      // presse-papiers refusé par le navigateur : le code est sélectionné pour une copie manuelle (Cmd/Ctrl + C)
      const el = codeRef.current;
      if (el) window.getSelection()?.selectAllChildren(el);
      toast.error("Copie automatique refusée par le navigateur : le code est sélectionné, copiez-le avec Cmd + C (ou Ctrl + C).");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Intégrer « ${name} »`} wide>
      <div className="space-y-4">
        <div role="radiogroup" aria-label="Format" className="grid gap-1 rounded-lg bg-surface p-1 sm:grid-cols-3">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={format === f.id}
              onClick={() => setFormat(f.id)}
              className={cn("h-9 rounded-md px-3 text-sm font-semibold", format === f.id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted">{current.help}</p>

        {!active && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
            Ce type est désactivé : tant qu&apos;il ne sera pas réactivé, le widget affichera « Réservation indisponible ».
          </p>
        )}

        {format !== "inline" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Texte du bouton">
              <Input value={text} maxLength={MAX_BUTTON_TEXT} onChange={(e) => setText(e.target.value)} placeholder={DEFAULT_BUTTON_TEXT} />
            </Field>
            {format === "trigger" && (
              <Field label="Apparence">
                <div className="flex gap-3 pt-2 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" checked={triggerStyle === "button"} onChange={() => setTriggerStyle("button")} /> Bouton</label>
                  <label className="flex items-center gap-1.5"><input type="radio" checked={triggerStyle === "popup"} onChange={() => setTriggerStyle("popup")} /> Lien texte (style de votre site)</label>
                </div>
              </Field>
            )}
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-semibold text-muted">Aperçu</p>
          <div className="rounded-xl border border-line bg-surface p-3">
            {format === "inline" ? (
              <InlinePreview src={`/rdv/${slug}/${EMBED_PATH}?mode=inline`} />
            ) : (
              <MockSite floating={format === "floating"}>
                {kind === "popup" ? (
                  <button type="button" onClick={() => setPopup(true)} className="font-semibold text-violet-strong underline">{label}</button>
                ) : (
                  <WidgetButton onClick={() => setPopup(true)} className={format === "floating" ? "absolute right-3 bottom-3" : ""}>{label}</WidgetButton>
                )}
              </MockSite>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">Aperçu réel : un créneau confirmé ici crée un vrai rendez-vous.</p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-muted">Code à coller</p>
            <Button size="sm" variant="primary" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} Copier le code</Button>
          </div>
          {/* bloc de code (pas un champ) : il ne prend pas le focus à l'ouverture et se sélectionne d'un clic */}
          <pre ref={codeRef} aria-label="Code d'intégration" className="overflow-x-auto rounded-lg border border-line bg-white p-3 font-label text-xs leading-relaxed whitespace-pre-wrap break-all text-ink select-all">
            {code}
          </pre>
          <p className="mt-1 text-xs text-muted">
            À coller tel quel dans votre site : Webflow (élément « Code Embed »), WordPress (bloc « HTML personnalisé ») ou une page HTML.
            Le code ne contient aucun mot de passe ni accès au CRM. Vos changements de disponibilités, de types ou d&apos;apparence s&apos;appliquent sans recopier le code.
          </p>
        </div>
      </div>
      {popup && <PopupPreview src={`/rdv/${slug}/${EMBED_PATH}?mode=popup`} onClose={() => setPopup(false)} />}
    </Modal>
  );
}

// Reprend l'apparence du bouton dessiné par le script sur le site hôte.
function WidgetButton({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-[15px] font-semibold text-white shadow-lg hover:bg-violet-strong", className)}>
      {children}
    </button>
  );
}

function MockSite({ floating, children }: { floating: boolean; children: React.ReactNode }) {
  return (
    <div className="relative h-48 overflow-hidden rounded-lg border border-line bg-white p-4" aria-label="Exemple de site">
      <div className="mb-3 h-3 w-1/3 rounded bg-surface" />
      <div className="mb-2 h-2 w-3/4 rounded bg-surface" />
      <div className="mb-4 h-2 w-2/3 rounded bg-surface" />
      {floating ? children : <div>{children}</div>}
    </div>
  );
}

function InlinePreview({ src }: { src: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(560);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== ref.current?.contentWindow) return;
      const d = e.data as { celyRdv?: number; type?: string; height?: number };
      if (d?.celyRdv === 1 && d.type === "resize" && typeof d.height === "number") setHeight(Math.max(120, Math.min(d.height, 4000)));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-lg">
      <iframe ref={ref} src={src} title="Aperçu du calendrier intégré" style={{ height }} className="block w-full border-0" />
    </div>
  );
}

function PopupPreview({ src, onClose }: { src: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { celyRdv?: number; type?: string })?.celyRdv === 1 && e.data.type === "close") onClose();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      // React fait remonter ces événements au panneau « Intégrer » : on les arrête ici pour ne fermer que l'aperçu
      onCancel={(e) => { e.stopPropagation(); e.preventDefault(); onClose(); }}
      onClose={(e) => e.stopPropagation()}
      className="m-auto h-[min(780px,calc(100%-2rem))] w-[min(1040px,calc(100%-2rem))] max-w-none overflow-hidden rounded-2xl border-0 bg-white p-0 backdrop:bg-ink/55 max-sm:h-full max-sm:w-full max-sm:rounded-none"
    >
      <button type="button" onClick={onClose} aria-label="Fermer l'aperçu" className="absolute top-2.5 right-2.5 z-10 grid size-9 place-items-center rounded-full bg-white text-ink shadow">
        <X size={18} />
      </button>
      <iframe src={src} title="Aperçu de la fenêtre de réservation" className="absolute inset-0 h-full w-full border-0" />
    </dialog>
  );
}
