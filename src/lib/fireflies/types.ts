// Formes échangées entre les routes et l'interface. Tout le contenu venant de Fireflies est non fiable :
// il s'affiche uniquement comme du texte.
import type { TranscriptLine } from "./normalize";

export type { TranscriptLine };

export type DisplayState = "importing" | "summary_pending" | "imported" | "failed";
export type LinkState = "to_link" | "linked" | "ignored";

export const DISPLAY_STATE_LABELS: Record<DisplayState, string> = {
  importing: "En cours d'import",
  summary_pending: "Résumé en attente",
  imported: "Importé",
  failed: "Échec",
};

export type LinkCandidate = { company_id: string; name: string; website: string | null; archived: boolean; reasons: string[] };

export type CallSummary = {
  gist?: string | string[];
  overview?: string | string[];
  short_summary?: string | string[];
  short_overview?: string | string[];
  action_items?: string | string[];
  keywords?: string | string[];
  outline?: string | string[];
  shorthand_bullet?: string | string[];
  bullet_gist?: string | string[];
  meeting_type?: string | string[];
  topics_discussed?: string | string[];
};

export type Call = {
  id: string;
  fireflies_id: string;
  title: string;
  occurred_at: string | null;
  duration_minutes: number | null;
  organizer_email: string | null;
  participants: string[];
  attendees: { name: string | null; email: string | null }[];
  speakers: { id: string | null; name: string }[];
  transcript_url: string | null;
  silent: boolean;
  summary: CallSummary;
  summary_state: "pending" | "available" | "unavailable";
  line_count: number;
  internal_note: string | null;
  link_state: LinkState;
  link_source: "appointment" | "email" | "manual" | null;
  link_reason: string | null;
  link_candidates: LinkCandidate[];
  company_id: string | null;
  project_id?: string | null;
  project_name?: string | null;
  company_name: string | null;
  person_id: string | null;
  booking_id: string | null;
  display_state: DisplayState;
  last_error: string | null;
};

export type ImportRow = {
  job_id: string;
  meeting_id: string;
  source: "webhook" | "sync";
  display_state: DisplayState;
  attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error: string | null;
  received_at: string;
  title: string | null;
  occurred_at: string | null;
  line_count: number | null;
  call_id: string | null;
};

export type FirefliesStatus = {
  configured: { apiKey: boolean; webhookSecret: boolean; serverSecret: boolean; cronSecret: boolean };
  connection: {
    account_email: string | null;
    last_webhook_at: string | null;
    last_success_at: string | null;
    last_sync_at: string | null;
    last_error_code: string | null;
    last_error_at: string | null;
    api_paused_until: string | null;
    own_emails: string[];
    own_domains: string[];
  } | null;
  pending: number;
  failed: ImportRow[];
  recent: ImportRow[];
};
