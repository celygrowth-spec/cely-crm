// Types et libellés du module Projets / portail client (partagés serveur et navigateur).

export type ProjectStatus = "a_preparer" | "en_cours" | "en_attente" | "termine" | "archive";

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  a_preparer: "À préparer",
  en_cours: "En cours",
  en_attente: "En attente",
  termine: "Terminé",
  archive: "Archivé",
};

export const PROJECT_STATUS_TONES: Record<ProjectStatus, "neutral" | "violet" | "warning" | "success" | "ink"> = {
  a_preparer: "neutral",
  en_cours: "violet",
  en_attente: "warning",
  termine: "success",
  archive: "neutral",
};

export type Project = {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  start_date: string | null;
  end_date: string | null;
  client_update: string | null;
  internal_note: string | null;
  blocked_reason: string | null;
  portal_published: boolean;
  archived_portal: "read_only" | "closed";
  archived_at: string | null;
  member_count: number;
  blocked_tasks?: number | null;
  /** enrichissements des phases suivantes (null tant qu'ils n'existent pas) */
  current_phase_name?: string | null;
  next_meeting_at?: string | null;
  open_client_tasks?: number | null;
  created_at: string;
  updated_at: string;
};

export type PortalAccess = {
  id: string;
  person_id: string;
  code_hint: string;
  code_generated_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

export type Member = {
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  access: PortalAccess | null;
};

/** Ce que reçoit le portail (aucun champ interne). */
export type PortalProject = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  start_date: string | null;
  end_date: string | null;
  client_update: string | null;
  read_only: boolean;
  company: string;
  updated_at: string;
};

export type PortalMe = {
  person: { id: string; first_name: string | null; last_name: string | null; company: string };
  projects: { id: string; name: string; status: ProjectStatus; read_only: boolean }[];
};

export type PhaseStatus = "a_venir" | "en_cours" | "termine" | "en_pause";
export const PHASE_STATUS_LABELS: Record<PhaseStatus, string> = { a_venir: "À venir", en_cours: "En cours", termine: "Terminée", en_pause: "En pause" };
export const PHASE_COLORS = ["violet", "blue", "teal", "green", "amber", "pink", "slate"] as const;
export type PhaseColor = (typeof PHASE_COLORS)[number];

export type Phase = {
  id: string;
  name: string;
  description: string | null;
  deliverables: string | null;
  start_date: string | null;
  end_date: string | null;
  color: PhaseColor;
  status: PhaseStatus;
  completed_at: string | null;
};

export type Milestone = { id: string; title: string; due_date: string; done: boolean; phase_id: string | null; visible_to_client?: boolean };

export type PortalMeeting = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: "upcoming" | "past" | "cancelled";
  meeting_url: string | null;
  location_kind: "video" | "phone" | "other" | null;
  participants: string | null;
  agenda?: string | null;
  has_recap: boolean;
};

export type RecapAction = { text: string; task_id?: string | null };
export type RecapLink = { label: string; url: string };
export type Recap = { summary: string | null; decisions: string | null; actions: RecapAction[]; next_step: string | null; links: RecapLink[]; published_at?: string | null };

export type PortalMeetingDetail = PortalMeeting & { recap: Recap | null };

/** Vue client complète d'un projet (portail et aperçu). */
export type PortalProjectView = PortalProject & {
  my_tasks?: PortalTask[];
  today: string;
  phases: Phase[];
  milestones: Milestone[];
  meetings: PortalMeeting[];
};

export type AdminMeeting = {
  id: string;
  booking_id: string;
  title: string | null;
  agenda: string | null;
  participants: string | null;
  visible_to_client: boolean;
  booking: {
    status: string; starts_at: string; ends_at: string; meeting_url: string | null; first_name: string; last_name: string;
    schedule_timezone: string; event_snapshot: { name: string; slug: string }; google_drift: { kind: "moved"; start: string; end: string | null } | { kind: "deleted" } | null;
    calendar_out_of_sync?: boolean;
  };
  recap: (Recap & { internal_note: string | null; status: "draft" | "published" }) | null;
};

export type TaskStatus = "a_faire" | "en_cours" | "bloque" | "termine";
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { a_faire: "À faire", en_cours: "En cours", bloque: "Bloqué", termine: "Terminé" };
export const TASK_STATUS_STYLES: Record<TaskStatus, string> = {
  a_faire: "bg-surface text-ink",
  en_cours: "bg-violet-soft text-violet-strong",
  bloque: "bg-amber-50 text-warning",
  termine: "bg-success/10 text-success",
};

export type TaskComment = { id: string; body: string; created_at: string; author: string; mine?: boolean; author_kind?: "owner" | "client" };

export type AdminTask = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee_kind: "owner" | "client";
  assignee_person_id: string | null;
  visible_to_client: boolean;
  due_date: string | null;
  blocked_reason: string | null;
  meeting_id: string | null;
  links: RecapLink[];
  created_by_kind: "owner" | "client";
  updated_by_kind: "owner" | "client";
  updated_by_person: string | null;
  updated_at: string;
  created_at: string;
};

export type PortalTask = {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  blocked_reason: string | null;
  assignee: { kind: "owner" | "team" | "me" | "person"; name: string };
  meeting: { id: string; title: string; starts_at: string } | null;
  updated_at: string;
  can_edit: boolean;
  comment_count: number;
  description?: string | null;
  links?: RecapLink[];
  comments?: TaskComment[];
};

export type IdeaStatus = "a_explorer" | "retenue" | "plus_tard" | "ecartee";
export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = { a_explorer: "À explorer", retenue: "Retenue", plus_tard: "Plus tard", ecartee: "Écartée" };
export const IDEA_STATUS_STYLES: Record<IdeaStatus, string> = {
  a_explorer: "bg-violet-soft text-violet-strong",
  retenue: "bg-success/10 text-success",
  plus_tard: "bg-amber-50 text-warning",
  ecartee: "bg-surface text-muted",
};
export type Idea = {
  id: string; title: string; description: string | null; status: IdeaStatus; decision_note: string | null; created_at: string; updated_at: string;
  author: string; mine?: boolean; can_edit?: boolean; has_task: boolean; task_id?: string | null;
  comments: { id: string; body: string; created_at: string; author: string }[];
};
