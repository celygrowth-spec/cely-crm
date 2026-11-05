// Types du module Rendez-vous (alignés sur supabase/migrations/20261105120000_rendez_vous.sql).
// Partagés entre serveur et navigateur : aucune donnée secrète ici.

export type LocationKind = "video" | "phone" | "other";
export type QuestionKind = "short" | "long" | "choice";

export type Question = {
  id: string;
  label: string;
  kind: QuestionKind;
  required: boolean;
  options?: string[];
};

export type EventType = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_min: number;
  location_kind: LocationKind;
  location_detail: string | null;
  meeting_url: string | null;
  google_meet: boolean;
  schedule_id: string;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  daily_limit: number | null;
  slot_interval_min: number | null;
  phone_required: boolean;
  questions: Question[];
  active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

/** Ce que voit le visiteur de la page publique. */
export type PublicEvent = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_min: number;
  location_kind: LocationKind;
  location_detail: string | null;
  has_meeting_link: boolean;
  phone_required: boolean;
  questions: Question[];
  horizon_days: number;
  timezone: string;
  display_name: string;
  intro: string | null;
};

export type Rule = { weekday: number; start: string; end: string };
export type Override = { date: string; start?: string | null; end?: string | null };

export type Schedule = {
  id: string;
  name: string;
  timezone: string;
  is_default: boolean;
  rules: Rule[];
  overrides: Override[];
};

export type Block = { id: string; label: string | null; starts_at: string; ends_at: string; all_day: boolean };

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "failed" | "expired";
export type DisplayStatus = "a_venir" | "a_renseigner" | "done" | "no_show" | "cancelled" | "pending";

export type Answer = { id: string; label: string; kind: QuestionKind; value: string };

export type EventSnapshot = {
  name: string;
  slug: string;
  description: string | null;
  duration_min: number;
  location_kind: LocationKind;
  location_detail: string | null;
  google_meet?: boolean;
};

export type CrmCandidate = { company_id: string; name: string; archived: boolean; reasons: string[] };

export type Booking = {
  id: string;
  event_type_id: string;
  status: BookingStatus;
  outcome: "done" | "no_show" | null;
  starts_at: string;
  ends_at: string;
  schedule_timezone: string;
  invitee_timezone: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  company_name: string | null;
  website: string | null;
  answers: Answer[];
  event_snapshot: EventSnapshot;
  meeting_url: string | null;
  company_id: string | null;
  person_id: string | null;
  crm_status: "linked" | "created" | "to_link";
  crm_candidates: CrmCandidate[];
  internal_note: string | null;
  cancel_reason: string | null;
  cancelled_by: "invitee" | "owner" | null;
  cancelled_at: string | null;
  version: number;
  calendar_target: boolean;
  google_event_id: string | null;
  calendar_out_of_sync: boolean;
  calendar_sync_error: string | null;
  created_at: string;
  updated_at: string;
  crm_company_name: string | null;
  display_status: DisplayStatus;
};

export type BookingEvent = { id: number; kind: string; actor: "invitee" | "owner" | "system"; data: Record<string, unknown>; created_at: string };

/** Détail renvoyé au détenteur d'un lien privé. */
export type PublicBooking = {
  id: string;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  invitee_timezone: string;
  schedule_timezone: string;
  first_name: string;
  last_name: string;
  email: string;
  event: EventSnapshot;
  meeting_url: string | null;
  version: number;
  cancelled_at: string | null;
  cancelled_by: "invitee" | "owner" | null;
  event_active: boolean;
  slug: string;
  display_name: string;
};

export type GoogleCalendar = { id: string; summary: string; primary: boolean; accessRole: string; backgroundColor?: string };

export type GoogleConnection = {
  google_email: string | null;
  scopes: string;
  calendars: GoogleCalendar[];
  check_calendar_ids: string[];
  destination_calendar_id: string | null;
  status: "connected" | "error";
  last_error: string | null;
  connected_at: string;
};

export type Interval = { start: string; end: string };

export const LOCATION_LABELS: Record<LocationKind, string> = {
  video: "Visioconférence",
  phone: "Téléphone",
  other: "Autre lieu",
};

export const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  a_venir: "À venir",
  a_renseigner: "À renseigner",
  done: "Réalisé",
  no_show: "Absent (no-show)",
  cancelled: "Annulé",
  pending: "En cours de confirmation",
};
