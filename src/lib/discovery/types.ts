// Données de l'onboarding de l'offre découverte (réponses des fonctions discovery_* et portal_discovery*).
import { OFFER_QUESTIONS, STEPS, type StepKey } from "./content";

export type StepStatus = "done" | "none" | "later";
export type TargetField = "name" | "sector" | "company_size" | "roles" | "geography" | "notes";

/** `unknown` : le client a coché « Je ne sais pas » (la valeur est alors vide). */
export type DiscoveryAnswer = { value: string; unknown?: boolean; rev: number; by: string | null; mine: boolean | null; at: string };
export type DiscoveryFile = { id: string; step: "blacklist" | "linkedin" | "documents"; name: string; size: number; account: string | null; by: string | null; mine: boolean | null; at: string };
export type DiscoveryComment = { id: string; body: string; by: string | null; mine: boolean | null; at: string };
export type DiscoveryTarget = Record<TargetField, string> & {
  position: number;
  client_filled: TargetField[];
  rev: number;
  validated_at: string | null;
  validated_by: string | null;
  modified_since_validation: boolean;
  comments: DiscoveryComment[];
};

export type DiscoveryView = {
  project: { id: string; name: string; company: string; read_only: boolean };
  me: { id: string; first_name: string | null } | null;
  settings: { lemlist_invite_email: string | null };
  started_at: string | null;
  sent_at: string | null;
  sent_by: string | null;
  position: string | null;
  answers: Record<string, DiscoveryAnswer>;
  steps: Partial<Record<StepKey, { status: StepStatus; by: string | null; at: string }>>;
  files: DiscoveryFile[];
  targets: DiscoveryTarget[];
};

export type DiscoveryChange = { kind: string; label: string; before: string | null; after: string | null; by: string | null; at: string };

export type DiscoveryAdmin =
  | { exists: false; enabled: false; suggested: boolean }
  | (DiscoveryView & {
      exists: true;
      enabled: boolean;
      enabled_source: "owner" | "sale";
      changed_after_send_at: string | null;
      /** Fiche du client et son site : pour voir si le lien donné dans l'onboarding y figure. */
      company_id?: string | null;
      company_website?: string | null;
      sent_task_id: string | null;
      /** Qui a marqué l'envoi, et origine de chaque valeur : client (portail), owner (moi) ou claude (proposition). */
      sent_origin?: "client" | "owner" | "claude" | null;
      origins?: {
        answers: Record<string, "client" | "owner" | "claude">;
        steps: Record<string, "client" | "owner" | "claude">;
        files: Record<string, "client" | "owner" | "claude">;
        targets: Record<string, TargetField[]>;
      };
      changes: DiscoveryChange[];
      contacts: { id: string; name: string | null; position: string | null; seen_at: string | null }[];
    });

/** Une cible est traitée quand le client l'a validée ou commentée. */
export const targetHandled = (t: DiscoveryTarget) => !!t.validated_at || t.comments.length > 0;

/** Étape terminée côté client (avant envoi). « later » laisse l'étape ouverte. */
export function stepComplete(v: DiscoveryView, key: StepKey): boolean {
  const s = v.steps[key]?.status;
  if (key === "targets") return v.targets.length > 0 && v.targets.every(targetHandled);
  if (key === "recap") return !!v.sent_at;
  return s === "done" || s === "none";
}

export function stepStarted(v: DiscoveryView, key: StepKey): boolean {
  if (stepComplete(v, key) || v.steps[key]) return true;
  if (key === "offer") return OFFER_QUESTIONS.some((q) => v.answers[q.key]);
  if (key === "blacklist" || key === "linkedin" || key === "documents") return v.files.some((f) => f.step === key);
  if (key === "targets") return v.targets.some((t) => targetHandled(t) || t.client_filled.length > 0);
  return false;
}

/** Avancement affiché dans mon panneau : non commencé, en cours, envoyé (étape complète et onboarding envoyé). */
export type StepProgress = "not_started" | "in_progress" | "complete" | "sent";
export function stepProgress(v: DiscoveryView, key: StepKey): StepProgress {
  if (stepComplete(v, key)) return v.sent_at ? "sent" : "complete";
  return stepStarted(v, key) ? "in_progress" : "not_started";
}

/** Questions où le client a coché « Je ne sais pas » : à compléter avec lui. */
export const unknownQuestions = (v: Pick<DiscoveryView, "answers">) => OFFER_QUESTIONS.filter((q) => v.answers[q.key]?.unknown);

export const CLIENT_STEPS = STEPS.filter((s) => s.key !== "welcome" && s.key !== "recap");
