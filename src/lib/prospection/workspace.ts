// Calculs dérivés d'un espace de campagne : contexte de variables, préparation, vues.
import type { Person } from "@/lib/crm/types";
import { personName } from "@/lib/format";
import type { CampaignStep, CampaignWorkspace, Draft, ParticipantRow } from "./service";
import { STEP_META, hasContactFor, renderTemplate, type VariableContext } from "./steps";

export function contextFor(p: ParticipantRow, person: Person | null | undefined): VariableContext {
  return {
    first_name: person?.first_name,
    last_name: person?.last_name,
    title: person?.title,
    company: p.company.name,
    website: p.company.domain_norm ?? p.company.website,
  };
}

export function targetPerson(p: ParticipantRow, people: Person[]): Person | null {
  return people.find((x) => x.id === p.person_id) ?? null;
}

export function contactsForPreview(ws: CampaignWorkspace) {
  return ws.participants.slice(0, 80).map((p) => {
    const person = targetPerson(p, ws.people);
    return { id: p.id, label: `${p.company.name}${person ? ` · ${personName(person)}` : ""}`, ctx: contextFor(p, person) };
  });
}

export function stepsOf(ws: Pick<CampaignWorkspace, "steps">, version: number): CampaignStep[] {
  return ws.steps.filter((s) => s.version === version).sort((a, b) => a.position - b.position);
}

export type Readiness = {
  missingVariables: { step: number; variables: string[] }[]; // variables sans valeur (et sans brouillon qui les remplace)
  missingContacts: { step: number; need: string }[]; // coordonnée nécessaire absente
  blockingContact: boolean; // coordonnée absente pour l'étape à venir
  noPerson: boolean;
  conflicts: number;
  doNotContact: boolean;
  ready: boolean;
};

/** Préparation d'un participant : variables, coordonnées et conflits. */
export function readiness(p: ParticipantRow, steps: CampaignStep[], people: Person[], drafts: Draft[], conflictCount: number): Readiness {
  const person = targetPerson(p, people);
  const ctx = contextFor(p, person);
  const missingVariables: Readiness["missingVariables"] = [];
  const missingContacts: Readiness["missingContacts"] = [];
  for (const s of steps) {
    if (s.position < p.current_step && p.status !== "a_preparer") continue; // étapes passées
    const draft = drafts.find((d) => d.participant_id === p.id && d.sequence_version === p.sequence_version && d.step_position === s.position);
    const subject = draft?.subject ?? s.subject;
    const body = draft?.body ?? s.message;
    const meta = STEP_META[s.step_type];
    if (meta.hasMessage) {
      const miss = [...new Set([...renderTemplate(subject, ctx).missing, ...renderTemplate(body, ctx).missing])];
      if (miss.length) missingVariables.push({ step: s.position, variables: miss });
    }
    if (!hasContactFor(s.step_type, person) && meta.needs) missingContacts.push({ step: s.position, need: meta.needs });
  }
  const noPerson = !person;
  // seule la coordonnée de l'étape à venir bloque ; celles des étapes suivantes sont des avertissements
  const nextPosition = p.status === "a_preparer" ? 1 : p.current_step;
  const blockingContact = missingContacts.some((m) => m.step === nextPosition);
  return {
    missingVariables,
    missingContacts,
    noPerson,
    conflicts: conflictCount,
    doNotContact: p.company.do_not_contact,
    blockingContact,
    ready: !noPerson && !missingVariables.length && !blockingContact && !p.company.do_not_contact,
  };
}

/** Message à préparer pour l'étape courante : brouillon s'il existe, sinon modèle personnalisé. */
export function preparedMessage(step: CampaignStep, draft: Draft | null | undefined, ctx: VariableContext) {
  const subjectSrc = draft?.subject ?? step.subject ?? "";
  const bodySrc = draft?.body ?? step.message ?? "";
  const s = renderTemplate(subjectSrc, ctx);
  const b = renderTemplate(bodySrc, ctx);
  return { subject: s.text, body: b.text, missing: [...new Set([...s.missing, ...b.missing])], fromDraft: !!draft };
}
