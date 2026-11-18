"use client";

// Accès du parcours d'onboarding : portail (session du contact) ou aperçu « Voir comme le client » (rien n'est écrit).
import type { DiscoveryView, StepStatus, TargetField } from "@/lib/discovery/types";
import type { UploadTicket } from "./uploader";

export type Res<T> = { ok: true; data: T } | { ok: false; error: string; network?: boolean };
export type AnswerResult = { ok: true; rev: number } | { ok: false; conflict: true; value: string; rev: number; by: string | null; at: string };
export type TargetResult = { ok: true; rev: number } | { ok: false; conflict: true; rev: number };

export type FlowApi = {
  preview: boolean;
  reload: () => Promise<Res<DiscoveryView>>;
  position: (screen: string) => Promise<Res<unknown>>;
  answer: (key: string, value: string, rev: number) => Promise<Res<AnswerResult>>;
  step: (step: string, status: StepStatus | null) => Promise<Res<unknown>>;
  fileStart: (step: string, name: string, size: number, account: string | null) => Promise<Res<UploadTicket>>;
  fileResume: (fileId: string) => Promise<Res<UploadTicket>>;
  fileConfirm: (fileId: string) => Promise<Res<unknown>>;
  fileAbort: (fileId: string) => Promise<Res<unknown>>;
  fileRemove: (id: string) => Promise<Res<unknown>>;
  fileUrl: (id: string) => Promise<Res<{ url: string }>>;
  targetFill: (position: number, field: TargetField, value: string, rev: number) => Promise<Res<TargetResult>>;
  targetValidate: (position: number, rev: number, valid: boolean) => Promise<Res<TargetResult>>;
  targetComment: (position: number, body: string) => Promise<Res<unknown>>;
  send: () => Promise<Res<{ already: boolean; sent_at: string; sent_by: string | null }>>;
};

async function call<T>(payload: Record<string, unknown>): Promise<Res<T>> {
  try {
    const res = await fetch("/api/portail/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) {
      window.location.replace("/portail");
      return { ok: false, error: j.error ?? "Session expirée" };
    }
    return res.ok ? { ok: true, data: j as T } : { ok: false, error: j.error ?? "Opération impossible", network: res.status >= 500 };
  } catch {
    return { ok: false, error: "Connexion impossible", network: true };
  }
}

export function portalApi(project: string): FlowApi {
  return {
    preview: false,
    reload: () => call({ op: "get", project }),
    position: (screen) => call({ op: "position", project, screen }),
    answer: (key, value, rev) => call({ op: "answer", project, key, value, rev }),
    step: (step, status) => call({ op: "step", project, step, status }),
    fileStart: (step, name, size, account) => call({ op: "file_start", project, step, name, size, account }),
    fileResume: (file) => call({ op: "file_resume", file }),
    fileConfirm: (file) => call({ op: "file_confirm", file }),
    fileAbort: (file) => call({ op: "file_abort", file }),
    fileRemove: (id) => call({ op: "file_remove", id }),
    fileUrl: (id) => call({ op: "file_url", id }),
    targetFill: (position, field, value, rev) => call({ op: "target_fill", project, position, field, value, rev }),
    targetValidate: (position, rev, valid) => call({ op: "target_validate", project, position, rev, valid }),
    targetComment: (position, body) => call({ op: "target_comment", project, position, body }),
    send: () => call({ op: "send", project }),
  };
}

/** Aperçu propriétaire : le parcours se déroule entièrement en mémoire. */
export function previewApi(view: DiscoveryView): FlowApi {
  const ok = <T,>(data: T): Promise<Res<T>> => Promise.resolve({ ok: true, data });
  const no = (): Promise<Res<never>> => Promise.resolve({ ok: false, error: "Aperçu : aucun fichier n'est envoyé." });
  return {
    preview: true,
    reload: () => ok(view),
    position: () => ok(null),
    answer: (_k, _v, rev) => ok({ ok: true as const, rev: rev + 1 }),
    step: () => ok(null),
    fileStart: no, fileResume: no, fileConfirm: no, fileAbort: () => ok(null), fileRemove: no, fileUrl: no,
    targetFill: (_p, _f, _v, rev) => ok({ ok: true as const, rev: rev + 1 }),
    targetValidate: (_p, rev) => ok({ ok: true as const, rev }),
    targetComment: () => ok(null),
    send: () => ok({ already: false, sent_at: new Date().toISOString(), sent_by: "Aperçu" }),
  };
}
