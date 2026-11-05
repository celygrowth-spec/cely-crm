// Détail d'un point : horaire, ordre du jour, lien, et récapitulatif publié (jamais de contenu fictif).
import { ExternalLink, Video } from "lucide-react";
import type { PortalMeetingDetail, Recap } from "@/lib/projects/types";
import { MeetingTime } from "./meeting-time";

export function RecapView({ recap }: { recap: Recap }) {
  return (
    <div className="space-y-4 text-sm">
      {recap.summary && <Block title="Résumé"><p className="leading-relaxed whitespace-pre-line text-ink">{recap.summary}</p></Block>}
      {recap.decisions && <Block title="Décisions"><p className="leading-relaxed whitespace-pre-line text-ink">{recap.decisions}</p></Block>}
      {recap.actions.length > 0 && (
        <Block title="Actions à réaliser">
          <ul className="list-disc space-y-1 pl-5 text-ink">{recap.actions.map((a, i) => <li key={i}>{a.text}</li>)}</ul>
        </Block>
      )}
      {recap.next_step && <Block title="Prochaine étape"><p className="whitespace-pre-line text-ink">{recap.next_step}</p></Block>}
      {recap.links.length > 0 && (
        <Block title="Liens utiles">
          <ul className="space-y-1">{recap.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-semibold text-violet-strong underline">{l.label} <ExternalLink size={12} /></a></li>)}</ul>
        </Block>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 font-label text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </div>
  );
}

export function MeetingDetail({ m }: { m: PortalMeetingDetail }) {
  return (
    <article className="space-y-4">
      <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-bold text-ink">{m.title}</h1>
          {m.status === "cancelled" && <span className="rounded-full bg-surface px-2 py-0.5 font-label text-xs text-muted">Annulé</span>}
          {m.status === "past" && <span className="rounded-full bg-surface px-2 py-0.5 font-label text-xs text-muted">Passé</span>}
        </div>
        <p className={`mt-1 text-sm ${m.status === "cancelled" ? "text-muted line-through" : "text-ink"}`}><MeetingTime start={m.starts_at} end={m.ends_at} tz={m.timezone} /></p>
        {m.participants && <p className="mt-1 text-sm text-muted">Participants : {m.participants}</p>}
        {m.meeting_url && (
          <a href={m.meeting_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-violet-strong">
            <Video size={16} aria-hidden /> Rejoindre le point
          </a>
        )}
        {m.agenda && (
          <div className="mt-4">
            <h2 className="mb-1 font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Ordre du jour</h2>
            <p className="text-sm whitespace-pre-line text-ink">{m.agenda}</p>
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
        <h2 className="mb-3 font-display text-lg font-bold text-ink">Récapitulatif</h2>
        {m.recap ? <RecapView recap={m.recap} /> : (
          <p className="text-sm text-muted">{m.status === "upcoming" ? "Le récapitulatif sera publié après le point." : m.status === "cancelled" ? "Ce point a été annulé." : "Le récapitulatif n'a pas encore été publié."}</p>
        )}
      </section>
    </article>
  );
}
