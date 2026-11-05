"use client";

import { useRouter } from "next/navigation";
import { IdeaCard, IdeaForm, run } from "@/components/projects/ideas";
import type { Idea } from "@/lib/projects/types";

async function op(payload: Record<string, unknown>): Promise<{ ok: true; data: Idea } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/portail/idees", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) window.location.replace("/portail");
    return res.ok ? { ok: true, data: j as Idea } : { ok: false, error: j.error ?? "Enregistrement impossible" };
  } catch {
    return { ok: false, error: "Connexion impossible : votre texte est conservé, réessayez." };
  }
}

export function PortalIdeas({ projectId, ideas, readOnly }: { projectId: string; ideas: Idea[]; readOnly: boolean }) {
  const router = useRouter();
  return (
    <div className="space-y-5">
      {!readOnly && (
        <section className="rounded-2xl border border-violet-line bg-violet-soft/30 p-4">
          <h2 className="mb-2 font-display text-base font-bold text-ink">Proposer une idée</h2>
          <IdeaForm label="Proposer" onSave={async (title, description) => !!(await run(() => op({ op: "save", project: projectId, idea: null, title, description: description || null }), "Idée proposée")) && (router.refresh(), true)} />
          <p className="mt-2 text-xs text-muted">Toutes les idées sont lues avec attention. Une idée proposée n&apos;engage pas sa réalisation et ne modifie pas le périmètre convenu : nous en discutons ensemble.</p>
        </section>
      )}
      {ideas.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-white p-8 text-center text-sm text-muted">Aucune idée pour l&apos;instant.{readOnly ? "" : " Une suggestion, une envie, une question ? Proposez-la ci-dessus."}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {ideas.map((i) => (
            <IdeaCard
              key={i.id + i.updated_at + i.comments.length}
              idea={i}
              onEdit={readOnly ? undefined : async (title, description) => !!(await run(() => op({ op: "save", project: projectId, idea: i.id, title, description: description || null }), "Idée modifiée")) && (router.refresh(), true)}
              onComment={readOnly ? undefined : async (body) => !!(await run(() => op({ op: "comment", project: projectId, idea: i.id, body }))) && (router.refresh(), true)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
