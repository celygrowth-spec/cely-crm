// Socle commun des générateurs (proposition, onboarding) : types et règles pures, partagés par le navigateur,
// le serveur et le connecteur MCP. Les questions elles-mêmes vivent dans src/content/generators.
export type GeneratorKind = "proposal" | "onboarding";

export type QuestionType = "text" | "long" | "choice" | "date" | "number" | "person" | "lines";

/** Ligne de devis : les montants viennent de mes réponses, jamais d'une estimation. Prix unitaire HT, en euros. */
export type QuoteLine = { label: string; description?: string; quantity: number; unit: string; unit_price: number; vat_rate: number; recurrence: "monthly" | "one_off" };
/** Personne de la fiche retenue comme réponse (signataire…). */
export type PersonValue = { person_id?: string | null; first_name: string; last_name: string; title?: string | null; email?: string | null };
export type AnswerValue = string | number | PersonValue | QuoteLine[];

export type Question = {
  /** Identifiant stable : ne le changez pas une fois des réponses enregistrées. */
  key: string;
  section: string;
  label: string;
  help?: string;
  type: QuestionType;
  options?: { value: string; label: string }[];
  required?: boolean;
  /** Cette réponse part aussi à Make (devis). */
  make?: boolean;
  /** Cette réponse reste dans le CRM : elle ne part pas à l'IA. */
  internal?: boolean;
};

export type Origin = "crm" | "claude" | "owner";
export type Answer = { value: AnswerValue; provenance: string | null; origin: Origin };
export type Answers = Record<string, Answer>;

export type Source = { cle: string; type: string; titre: string; date: string | null; retenue: boolean };
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  fiche: "Fiche", personnes: "Interlocuteurs", diagnostic: "Diagnostic", proposition: "Proposition précédente", appel: "Appel et transcription",
  email: "Email", rdv: "Rendez-vous", notes: "Notes et historique", fichier: "Fichier de la fiche",
};

export type LibraryChoice = { id: string; name: string; kind: "file" | "prompt"; folder: string; selected: boolean };

export type SlidesStatus = "pending" | "uploading" | "ready" | "failed";
export type GeneratorVersion = {
  id: string; version: number; slides_status: SlidesStatus; slides_error: string | null; file_id: string | null; feedback: string | null;
  created_at: string; ready_at: string | null; validated_at: string | null; sent_at: string | null; answers: Answers;
};

export type GeneratorDossier = {
  id: string; kind: GeneratorKind; company_id: string; project_id: string | null; created_at: string;
  prefill_state: "none" | "requested" | "done" | "failed";
  trigger_ref: string | null; triggered_at: string | null; trigger_error: string | null; session_url: string | null; last_error: string | null;
  answers: Answers; sources: Source[]; library: LibraryChoice[]; versions: GeneratorVersion[];
};

/** États visibles, communs aux générateurs. */
export type GeneratorState = "a_preparer" | "en_generation" | "a_relire" | "validee" | "envoyee" | "echec";
export const STATE_LABELS: Record<GeneratorState, string> = {
  a_preparer: "À préparer", en_generation: "En génération", a_relire: "À relire", validee: "Validée", envoyee: "Envoyée", echec: "Échec",
};
export const STATE_TONES: Record<GeneratorState, "neutral" | "violet" | "warning" | "success" | "danger"> = {
  a_preparer: "neutral", en_generation: "violet", a_relire: "warning", validee: "success", envoyee: "success", echec: "danger",
};

export const latestVersion = (d: Pick<GeneratorDossier, "versions">) => [...d.versions].sort((a, b) => b.version - a.version)[0] ?? null;

export function versionState(v: Pick<GeneratorVersion, "slides_status" | "validated_at" | "sent_at">): GeneratorState {
  if (v.sent_at) return "envoyee";
  if (v.validated_at) return "validee";
  if (v.slides_status === "failed") return "echec";
  return v.slides_status === "ready" ? "a_relire" : "en_generation";
}

/** État du dossier : celui de sa dernière version ; sans version, « à préparer » (ou échec du pré-remplissage). */
export function dossierState(d: Pick<GeneratorDossier, "versions" | "prefill_state" | "last_error">): GeneratorState {
  const v = latestVersion(d);
  if (v) return versionState(v);
  return d.prefill_state === "failed" && d.last_error ? "echec" : "a_preparer";
}

export const isBlank = (v: AnswerValue | undefined | null): boolean =>
  v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** Questions obligatoires encore sans réponse. */
export const missingRequired = (questions: Question[], answers: Answers) => questions.filter((q) => q.required && isBlank(answers[q.key]?.value));

export const sections = (questions: Question[]) => [...new Set(questions.map((q) => q.section))];

export const ORIGIN_LABELS: Record<Origin, string> = { crm: "Repris du CRM", claude: "Proposé par Claude", owner: "Saisi par vous" };
/** Provenance affichée sous une réponse : « repris du diagnostic », « repris de l'appel du 12/11 »… */
export const provenanceLabel = (a: Answer | undefined) => (!a ? null : a.origin === "owner" ? null : a.provenance ?? ORIGIN_LABELS[a.origin]);

const eur = (n: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
export const lineTotal = (l: QuoteLine) => Math.round(l.quantity * l.unit_price * 100) / 100;
export const linesTotal = (lines: QuoteLine[]) => Math.round(lines.reduce((n, l) => n + lineTotal(l), 0) * 100) / 100;

/** Réponse lisible (récapitulatif, envoi à l'IA). */
export function answerText(q: Question, v: AnswerValue | undefined): string {
  if (isBlank(v)) return "";
  if (q.type === "choice") return q.options?.find((o) => o.value === v)?.label ?? String(v);
  if (q.type === "person") {
    const p = v as PersonValue;
    return [`${p.first_name} ${p.last_name}`.trim(), p.title, p.email].filter(Boolean).join(" · ");
  }
  if (q.type === "lines") {
    return (v as QuoteLine[]).map((l) => `${l.label} : ${l.quantity} ${l.unit} × ${eur(l.unit_price)} HT${l.recurrence === "monthly" ? " / mois" : ""} (TVA ${l.vat_rate} %)`).join("\n");
  }
  if (q.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
  return String(v);
}

/** Contrôle de forme d'une réponse avant enregistrement ; renvoie un message, ou null si elle est acceptable. */
export function answerProblem(q: Question, v: unknown): string | null {
  if (v === "" || v === null || v === undefined) return null;
  switch (q.type) {
    case "text": return typeof v === "string" && v.length <= 500 ? null : "Réponse trop longue (500 caractères au plus).";
    case "long": return typeof v === "string" && v.length <= 10000 ? null : "Réponse trop longue (10 000 caractères au plus).";
    case "choice": return typeof v === "string" && (q.options ?? []).some((o) => o.value === v) ? null : "Choix inconnu.";
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? null : "Date invalide.";
    case "number": return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? null : "Nombre invalide.";
    case "person": {
      const p = v as Partial<PersonValue>;
      return p && typeof p === "object" && typeof p.first_name === "string" && typeof p.last_name === "string" && `${p.first_name}${p.last_name}`.trim() ? null : "Indiquez le prénom et le nom.";
    }
    case "lines": {
      if (!Array.isArray(v) || v.length > 30) return "30 lignes au plus.";
      for (const l of v as Partial<QuoteLine>[]) {
        if (!l || typeof l.label !== "string" || !l.label.trim() || l.label.length > 200) return "Chaque ligne a besoin d'un libellé.";
        if (typeof l.quantity !== "number" || !(l.quantity > 0) || l.quantity > 100000) return `Quantité invalide pour « ${l.label} ».`;
        if (typeof l.unit_price !== "number" || !(l.unit_price >= 0) || l.unit_price > 1e8) return `Prix invalide pour « ${l.label} ».`;
        if (typeof l.vat_rate !== "number" || l.vat_rate < 0 || l.vat_rate > 100) return `TVA invalide pour « ${l.label} ».`;
        if (l.recurrence !== "monthly" && l.recurrence !== "one_off") return `Précisez si « ${l.label} » est mensuel ou ponctuel.`;
        if (typeof l.unit !== "string" || l.unit.length > 30) return `Unité invalide pour « ${l.label} ».`;
      }
      return null;
    }
  }
}

// Messages pour Claude : ils ne portent que l'identifiant du dossier, Claude lit le reste par le connecteur.
export const GENERATOR_NAMES: Record<GeneratorKind, { title: string; the: string; tool: string }> = {
  proposal: { title: "Proposition", the: "la proposition", tool: "open_proposal" },
  onboarding: { title: "Onboarding", the: "l'onboarding", tool: "open_onboarding_generator" },
};
export type GeneratorStage = "preremplissage" | "slides";
/** Texte envoyé à la tâche Claude : « proposition:slides:<id> ». */
export const generatorRoutineText = (kind: GeneratorKind, stage: GeneratorStage, id: string) => `${kind === "proposal" ? "proposition" : "onboarding-generateur"}:${stage}:${id}`;
export const generatorPrompt = (kind: GeneratorKind, stage: GeneratorStage, id: string) =>
  stage === "preremplissage"
    ? `${GENERATOR_NAMES[kind].title} Cely, dossier ${id}. Avec le connecteur du CRM, appelle ${GENERATOR_NAMES[kind].tool} avec cet identifiant, lis les sources retenues, puis propose une réponse aux questions restées vides, avec leur provenance.`
    : `${GENERATOR_NAMES[kind].title} Cely, dossier ${id} : la génération est demandée. Avec le connecteur du CRM, appelle ${GENERATOR_NAMES[kind].tool} avec cet identifiant, puis suis les consignes qu'il renvoie et dépose le résultat dans le CRM.`;
