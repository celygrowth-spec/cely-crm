// Types d'étapes manuelles et variables de personnalisation (partagés client / serveur).

export const STEP_TYPES = [
  "linkedin_invite",
  "linkedin_message",
  "email",
  "call",
  "linkedin_visit",
  "linkedin_interaction",
  "task",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export type StepMeta = {
  label: string;
  short: string;
  channel: "linkedin" | "email" | "phone" | "other";
  hasSubject: boolean;
  hasMessage: boolean; // un texte est préparé pour le prospect
  messageRequired: boolean; // le contenu envoyé est obligatoire pour valider
  doneLabel: string; // libellé du bouton de validation
  needs: "email" | "linkedin" | "phone" | null; // coordonnée nécessaire
};

export const STEP_META: Record<StepType, StepMeta> = {
  linkedin_invite: { label: "Invitation LinkedIn", short: "Invitation", channel: "linkedin", hasSubject: false, hasMessage: true, messageRequired: false, doneLabel: "Invitation envoyée", needs: "linkedin" },
  linkedin_message: { label: "Message LinkedIn", short: "Message", channel: "linkedin", hasSubject: false, hasMessage: true, messageRequired: true, doneLabel: "Marquer comme envoyé", needs: "linkedin" },
  email: { label: "Email", short: "Email", channel: "email", hasSubject: true, hasMessage: true, messageRequired: true, doneLabel: "Marquer comme envoyé", needs: "email" },
  call: { label: "Appel", short: "Appel", channel: "phone", hasSubject: false, hasMessage: false, messageRequired: false, doneLabel: "Appel effectué", needs: "phone" },
  linkedin_visit: { label: "Visite de profil", short: "Visite", channel: "linkedin", hasSubject: false, hasMessage: false, messageRequired: false, doneLabel: "Visite effectuée", needs: "linkedin" },
  linkedin_interaction: { label: "Interaction LinkedIn", short: "Interaction", channel: "linkedin", hasSubject: false, hasMessage: false, messageRequired: false, doneLabel: "Interaction effectuée", needs: "linkedin" },
  task: { label: "Tâche libre", short: "Tâche", channel: "other", hasSubject: false, hasMessage: false, messageRequired: false, doneLabel: "Tâche faite", needs: null },
};

export const NEEDS_LABEL = { email: "email", linkedin: "profil LinkedIn", phone: "téléphone" } as const;

export type SequenceStep = {
  name: string;
  step_type: StepType;
  delay_days: number;
  subject?: string | null;
  message?: string | null;
  instructions?: string | null;
};

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const VARIABLES = [
  { key: "prenom", label: "Prénom" },
  { key: "nom", label: "Nom" },
  { key: "entreprise", label: "Entreprise" },
  { key: "poste", label: "Poste" },
  { key: "site", label: "Site web" },
] as const;
export type VariableKey = (typeof VARIABLES)[number]["key"];

export type VariableContext = {
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  company?: string | null;
  website?: string | null;
};

const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export function valueOf(key: string, ctx: VariableContext): string | null {
  const v = (() => {
    switch (key) {
      case "prenom": return ctx.first_name;
      case "nom": return ctx.last_name;
      case "entreprise": return ctx.company;
      case "poste": return ctx.title;
      case "site": return ctx.website;
      default: return null;
    }
  })();
  const s = (v ?? "").trim();
  return s ? s : null;
}

export function usedVariables(text?: string | null): string[] {
  return [...new Set([...(text ?? "").matchAll(TOKEN)].map((m) => m[1].toLowerCase()))];
}

export function unknownVariables(text?: string | null): string[] {
  const known = new Set<string>(VARIABLES.map((v) => v.key));
  return usedVariables(text).filter((k) => !known.has(k));
}

/**
 * Remplace les variables connues. Une valeur absente laisse le jeton {{x}} en place
 * (jamais « undefined ») et est signalée dans `missing`.
 */
export function renderTemplate(text: string | null | undefined, ctx: VariableContext): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = (text ?? "").replace(TOKEN, (token, raw: string) => {
    const key = raw.toLowerCase();
    const v = valueOf(key, ctx);
    if (v == null) {
      missing.add(key);
      return token;
    }
    return v;
  });
  return { text: out, missing: [...missing] };
}

/** Jetons restant dans un texte déjà personnalisé (bloquent la validation). */
export function remainingTokens(text?: string | null): string[] {
  return usedVariables(text);
}

export function variableLabel(key: string): string {
  return VARIABLES.find((v) => v.key === key)?.label ?? key;
}

/** Coordonnée disponible pour un type d'étape. */
export function hasContactFor(type: StepType, p: { email?: string | null; linkedin_url?: string | null; phone?: string | null } | null | undefined): boolean {
  const need = STEP_META[type].needs;
  if (!need) return true;
  if (!p) return false;
  return need === "email" ? !!p.email : need === "linkedin" ? !!p.linkedin_url : !!p.phone;
}

/** Délai cumulé indicatif depuis l'activation (jours). */
export function cumulativeDays(steps: Pick<SequenceStep, "delay_days">[]): number[] {
  let total = 0;
  return steps.map((s) => (total += s.delay_days));
}
