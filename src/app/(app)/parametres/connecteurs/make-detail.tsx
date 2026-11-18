"use client";

// Détail du connecteur Make : scénarios (nom et adresse du webhook), test de connexion, adresse de retour, journal.
// L'adresse d'un webhook se saisit ici mais n'est jamais réaffichée : elle n'existe en clair que sur le serveur.
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Plus, Send, Trash2 } from "lucide-react";
import { deleteMakeScenarioAction, saveMakeScenarioAction, testMakeScenarioAction } from "@/app/connecteurs-actions";
import { Button, Input, Spinner, cn } from "@/components/ui";
import { CALL_STATUS_LABEL, EVENT_LABEL, QUOTE_SCENARIO, type MakeDetail as Detail, type MakeScenario } from "@/lib/make/rules";

const at = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

export function MakeDetail({ initial, onChanged }: { initial: Detail; onChanged: () => void }) {
  const [d, setD] = useState(initial);
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<MakeScenario | "new" | null>(initial.scenarios.length ? null : "new");
  const update = (next: Detail) => { setD(next); onChanged(); };

  const test = (s: MakeScenario) => {
    if (testing) return;
    setTesting(s.id);
    start(async () => {
      const r = await testMakeScenarioAction(s.id);
      setTesting(null);
      if (!r.ok) return void toast.error(r.error);
      (r.data.ok ? toast.success : toast.error)(r.data.message);
      update(r.data.detail);
    });
  };
  const remove = (s: MakeScenario) => {
    if (!confirm(`Retirer le scénario « ${s.name} » ?\n\nLe CRM ne pourra plus l'appeler. Rien n'est modifié dans Make.`)) return;
    start(async () => {
      const r = await deleteMakeScenarioAction(s.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success("Scénario retiré");
      update(r.data);
    });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.callbackUrl);
      toast.success("Adresse copiée");
    } catch {
      toast.error("Copie impossible : sélectionnez l'adresse à la main.");
    }
  };

  return (
    <>
      <section className="mt-5" data-make-scenarios>
        <h3 className="mb-1.5 font-label text-[11px] font-bold tracking-wide text-muted uppercase">Scénarios</h3>
        {d.scenarios.length === 0 && <p className="text-sm text-muted">Aucun scénario. Le premier attendu est « {QUOTE_SCENARIO.name} ».</p>}
        <ul className="divide-y divide-line text-sm">
          {d.scenarios.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2" data-scenario={s.key}>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{s.name}</p>
                <p className="text-xs text-muted">Adresse enregistrée, masquée · modifié le {at(s.updated_at)}</p>
              </div>
              <Button size="sm" disabled={pending || !!testing} onClick={() => test(s)}>{testing === s.id ? <Spinner /> : <Send size={13} />} Tester la connexion</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(s)}>Modifier</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => remove(s)} aria-label={`Retirer ${s.name}`}><Trash2 size={13} /></Button>
            </li>
          ))}
        </ul>
        {editing ? (
          <ScenarioForm
            key={editing === "new" ? "new" : editing.id}
            scenario={editing === "new" ? null : editing}
            suggested={d.scenarios.some((s) => s.key === QUOTE_SCENARIO.key) ? "" : QUOTE_SCENARIO.name}
            onCancel={() => setEditing(null)}
            onSaved={(next) => { setEditing(null); update(next); }}
          />
        ) : (
          <Button className="mt-2" size="sm" onClick={() => setEditing("new")}><Plus size={13} /> Ajouter un scénario</Button>
        )}
        <p className="mt-2 text-xs text-muted">Le test envoie un appel marqué <code>&quot;test&quot;: true</code>, sans aucune donnée de client : votre scénario doit s&apos;arrêter sur ce filtre.</p>
      </section>

      <section className="mt-5">
        <h3 className="mb-1.5 font-label text-[11px] font-bold tracking-wide text-muted uppercase">Retour de Make vers le CRM</h3>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-3 py-2 text-sm" data-make-callback>{d.callbackUrl}</code>
          <Button size="sm" onClick={copy} aria-label="Copier l'adresse de retour"><Copy size={13} /> Copier</Button>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Dans Make, module HTTP : méthode POST, en-tête <code>Authorization: Bearer</code> suivi du secret partagé.
          {d.secretPresent ? " Le secret est présent côté serveur." : " Le secret est absent du serveur : tout retour est refusé."}
        </p>
      </section>

      <section className="mt-5" data-make-journal>
        <h3 className="mb-1.5 font-label text-[11px] font-bold tracking-wide text-muted uppercase">Derniers appels</h3>
        {d.calls.length === 0 ? <p className="text-sm text-muted">Aucun appel pour le moment.</p> : (
          <ul className="divide-y divide-line text-xs">
            {d.calls.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="text-muted">{at(c.at)}</span>
                <span className="font-semibold">{c.direction === "out" ? c.scenario ?? "Scénario" : "Retour de Make"}</span>
                <span className="text-muted">{EVENT_LABEL[c.event] ?? c.event}</span>
                <span className={cn("ml-auto font-semibold", c.status === "ok" ? "text-success" : c.status === "duplicate" || c.status === "ignored" ? "text-muted" : "text-danger")}>{CALL_STATUS_LABEL[c.status]}</span>
                {c.error && <span className="w-full text-danger">{c.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ScenarioForm({ scenario, suggested, onCancel, onSaved }: { scenario: MakeScenario | null; suggested: string; onCancel: () => void; onSaved: (d: Detail) => void }) {
  const [name, setName] = useState(scenario?.name ?? suggested);
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      const r = await saveMakeScenarioAction({ id: scenario?.id ?? null, name, url });
      if (!r.ok) return void toast.error(r.error);
      toast.success(scenario ? "Scénario modifié" : "Scénario enregistré");
      onSaved(r.data);
    });
  };
  return (
    <form onSubmit={save} className="mt-2 grid gap-2 rounded-xl border border-line p-3" data-make-form>
      <label className="block text-sm">
        <span className="font-label text-xs font-semibold text-muted">Nom du scénario</span>
        <Input className="mt-1" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="font-label text-xs font-semibold text-muted">Adresse du webhook{scenario ? " (laisser vide pour garder l'adresse actuelle)" : ""}</span>
        <Input className="mt-1" type="password" autoComplete="off" value={url} required={!scenario} placeholder="https://hook.eu2.make.com/…" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>{pending ? "Enregistrement…" : "Enregistrer"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}
