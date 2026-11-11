// Préparation d'un projet après « Gagné » : types, libellés et messages pour Claude (serveur et navigateur).
import { claudeLink } from "@/lib/crm/diagnostic-rules";

export type OnboardingStatus = "preparing" | "to_complete" | "ready";

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  preparing: "Préparation en cours",
  to_complete: "À compléter",
  ready: "Prêt à démarrer",
};
export const ONBOARDING_STATUS_TONES: Record<OnboardingStatus, "violet" | "warning" | "success"> = {
  preparing: "violet",
  to_complete: "warning",
  ready: "success",
};

export type SourceRef = { kind: "file" | "call" | "diagnostic" | "company" | "answer"; id?: string | null; label?: string; excerpt?: string; at?: number };

export type SectionItem = {
  text: string;
  refs?: SourceRef[];
  /** proposé par le CRM ou Claude, à confirmer */
  suggested?: boolean;
  provisional?: boolean;
  date?: string | null;
  date_status?: "confirmed" | "provisional" | "unknown";
};
export type SectionOrigin = "crm" | "claude" | "owner";
export type Section = { items: SectionItem[]; origin: SectionOrigin; updated_at?: string };

export const SECTION_KEYS = ["mission", "objectives", "scope", "deliverables", "phases", "first_actions", "context", "findings"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  mission: "Résumé de la mission",
  objectives: "Objectifs",
  scope: "Périmètre convenu",
  deliverables: "Livrables",
  phases: "Phases et échéances",
  first_actions: "Premières actions",
  context: "Contexte et besoins exprimés",
  findings: "Constats du diagnostic",
};

export const ORIGIN_LABELS: Record<SectionOrigin, string> = { crm: "Repris du CRM", claude: "Proposé par Claude", owner: "Corrigé par vous" };

export type ItemKind = "proposal" | "date" | "text" | "choice" | "contact" | "link" | "conflict" | "client_request";
export type ItemStatus = "open" | "answered" | "not_applicable" | "resolved";
export type ItemOption = { label: string; text?: string; file_id?: string; diagnostic_id?: string; refs?: SourceRef[] };

export type OnboardingItem = {
  id: string;
  key: string;
  label: string;
  detail: string | null;
  kind: ItemKind;
  required: boolean;
  priority: number;
  options: ItemOption[];
  refs: SourceRef[];
  target_section: SectionKey | null;
  origin: SectionOrigin;
  status: ItemStatus;
  answer: string | null;
  answer_file_id: string | null;
  answered_by: "owner" | "client" | null;
  answered_at: string | null;
  client_task_id: string | null;
  request_text: string | null;
  request_shared_at: string | null;
};

export type OnboardingDeck = {
  id: string;
  version: number;
  status: "requested" | "uploading" | "ready" | "failed";
  file_id: string | null;
  error: string | null;
  session_url: string | null;
  requested_at: string;
  ready_at: string | null;
  shared_at: string | null;
};

/** `reading` : contenu lu par le CRM (K10) : ok, empty (rien de lisible), unsupported, failed, ou null (pas encore lu). */
export type CompanyDoc = { id: string; display_name: string; category: string | null; created_at: string; reading?: { status: string; error: string | null; chars: number } | null };
export type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: boolean };

export type Onboarding = {
  project_id: string;
  company_id: string;
  sale_id: string | null;
  /** date de signature, sinon de clôture de la vente */
  won_on: string;
  status: OnboardingStatus;
  open_required: number;
  open_optional: number;
  prep_state: "pending" | "done" | "failed";
  prep_error: string | null;
  analysis_state: "none" | "requested" | "done" | "failed";
  analysis_error: string | null;
  analysis_requested_at: string | null;
  analysis_session_url: string | null;
  analysis_auto: boolean;
  deck_auto: boolean;
  proposal_file_id: string | null;
  diagnostic_id: string | null;
  sections: Partial<Record<SectionKey, Section>>;
  items: OnboardingItem[];
  decks: OnboardingDeck[];
  documents: CompanyDoc[];
  contacts: Contact[];
  start_date: string | null;
  portal_published: boolean;
  members: { id: string; name: string }[];
};

/** Texte envoyé à la tâche Claude (et prérempli dans Claude en secours) : l'identifiant du projet et l'étape. */
export const routineText = (projectId: string, stage: "analyse" | "slides") => `onboarding:${stage}:${projectId}`;

export const analysisPrompt = (projectId: string) =>
  `Préparation de projet Cely, projet ${projectId}. Avec le connecteur du CRM, appelle open_project_onboarding avec cet identifiant, lis la proposition retenue, les appels et le diagnostic, puis enregistre l'analyse avec save_project_onboarding_analysis. Ne modifie pas les sections que j'ai corrigées.`;

export const slidesPrompt = (projectId: string) =>
  `Slides d'onboarding Cely, projet ${projectId}. Avec le connecteur du CRM, appelle open_project_onboarding avec cet identifiant, génère le PowerPoint d'onboarding à partir du contenu vérifié (modèle Cely de la bibliothèque s'il existe), puis dépose-le avec start_onboarding_deck_upload et confirm_onboarding_deck_upload.`;

export { claudeLink };
