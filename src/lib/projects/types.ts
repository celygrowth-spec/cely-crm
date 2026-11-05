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
