"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, CopyPlus, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { deleteEventTypeAction, duplicateEventTypeAction, saveSettingsAction, setEventTypeActiveAction } from "@/app/rendez-vous-actions";
import { Badge, Button, Card, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { LOCATION_LABELS, type EventType } from "@/lib/appointments/types";
import { formatDuration } from "@/components/rdv/public-bits";

export function TypesView({ types, schedules, baseUrl, settings }: {
  types: EventType[]; schedules: { id: string; name: string }[]; baseUrl: string; settings: { display_name: string; intro: string | null };
}) {
  const sync = useSync();
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function act(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) {
    setBusy(id);
    const r = await attempt(fn as () => Promise<{ ok: true } | { ok: false; error: string }>);
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    sync();
  }

  return (
    <div className="space-y-6">
      {types.length === 0 ? (
        <EmptyState
          title="Aucun type de rendez-vous"
          description="Créez par exemple « Appel découverte » (30 min, visioconférence) puis partagez son lien."
          action={<Link className="font-semibold text-violet-strong underline" href="/rendez-vous/types/nouveau">Créer un type</Link>}
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {types.map((t) => {
            const url = `${baseUrl}/rdv/${t.slug}`;
            return (
              <li key={t.id}>
                <Card className={`row-in flex h-full flex-col p-4 ${t.active ? "" : "bg-surface"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/rendez-vous/types/${t.id}`} className="font-display text-base font-bold text-ink hover:underline">{t.name}</Link>
                      <p className="text-xs text-muted">{formatDuration(t.duration_min)} · {LOCATION_LABELS[t.location_kind]} · {schedules.find((s) => s.id === t.schedule_id)?.name}</p>
                    </div>
                    <Badge tone={t.active ? "success" : "neutral"}>{t.active ? "Actif" : "Désactivé"}</Badge>
                  </div>
                  <p className="mt-2 truncate font-label text-xs text-muted">{url}</p>
                  <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                    <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(url).catch(() => undefined); setCopied(t.id); setTimeout(() => setCopied(null), 1500); }}>
                      {copied === t.id ? <Check size={13} /> : <Copy size={13} />} Copier le lien
                    </Button>
                    {t.active && <a href={`/rdv/${t.slug}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-semibold hover:border-violet"><ExternalLink size={13} /> Prévisualiser</a>}
                    <Link href={`/rendez-vous/types/${t.id}`} className="inline-flex h-7 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-semibold hover:border-violet"><Pencil size={13} /> Modifier</Link>
                    <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => act(t.id, () => duplicateEventTypeAction(t.id), "Type dupliqué (désactivé)")}><CopyPlus size={13} /> Dupliquer</Button>
                    <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => act(t.id, () => setEventTypeActiveAction(t.id, !t.active), t.active ? "Type désactivé" : "Type activé")}>
                      {t.active ? "Désactiver" : "Activer"}
                    </Button>
                    {!t.active && (
                      <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => confirm(`Supprimer « ${t.name} » ?`) && act(t.id, () => deleteEventTypeAction(t.id), "Type supprimé")} aria-label="Supprimer">
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <PublicIdentity settings={settings} />
    </div>
  );
}

function PublicIdentity({ settings }: { settings: { display_name: string; intro: string | null } }) {
  const [name, setName] = useState(settings.display_name);
  const [intro, setIntro] = useState(settings.intro ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = name !== settings.display_name || intro !== (settings.intro ?? "");
  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold text-ink">Identité des pages publiques</h2>
      <p className="mb-3 text-xs text-muted">Affichée à côté du logo Cely Growth sur toutes les pages de réservation.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Nom affiché"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Présentation courte (facultatif)"><Textarea value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={1000} className="min-h-9" /></Field>
      </div>
      {dirty && (
        <Button className="mt-3" variant="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await attempt(() => saveSettingsAction({ display_name: name, intro: intro || null }));
          setBusy(false);
          if (r.ok) toast.success("Identité enregistrée");
          else toast.error(r.error);
        }}>Enregistrer</Button>
      )}
    </Card>
  );
}
