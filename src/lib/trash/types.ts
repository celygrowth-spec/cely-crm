// Corbeille : types et libellés partagés (interface, actions, connecteur Claude).

export const TRASH_KINDS = [
  "company", "person", "project", "project_task", "project_idea", "project_phase", "project_meeting",
  "finance_mission", "finance_invoice", "finance_payment",
] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export const KIND_LABEL: Record<TrashKind, string> = {
  company: "Entreprise",
  person: "Contact",
  project: "Projet client",
  project_task: "Tâche de projet",
  project_idea: "Idée",
  project_phase: "Phase du planning",
  project_meeting: "Point de suivi",
  finance_mission: "Revenu",
  finance_invoice: "Facture",
  finance_payment: "Règlement",
};

/** Éléments liés, par table : [singulier, pluriel]. L'ordre est celui de l'affichage. */
const TABLES: [string, string, string][] = [
  ["people", "contact", "contacts"],
  ["sales", "vente", "ventes"],
  ["projects", "projet", "projets"],
  ["project_tasks", "tâche du projet", "tâches du projet"],
  ["project_ideas", "idée", "idées"],
  ["project_phases", "phase du planning", "phases du planning"],
  ["project_milestones", "jalon", "jalons"],
  ["project_meetings", "point de suivi", "points de suivi"],
  ["project_folders", "dossier", "dossiers"],
  ["project_files", "document partagé (il reste sur la fiche)", "documents partagés (ils restent sur la fiche)"],
  ["portal_accesses", "accès au portail", "accès au portail"],
  ["finance_missions", "revenu", "revenus"],
  ["finance_invoices", "facture ou avoir", "factures ou avoirs"],
  ["finance_payments", "règlement", "règlements"],
  ["tasks", "relance ou tâche à faire", "relances ou tâches à faire"],
  ["interactions", "entrée d'historique", "entrées d'historique"],
  ["company_files", "fichier", "fichiers"],
  ["diagnostics", "diagnostic", "diagnostics"],
  ["mail_messages", "mail", "mails"],
  ["fireflies_calls", "appel enregistré", "appels enregistrés"],
  ["time_entries", "session de temps", "sessions de temps"],
  ["campaign_participants", "participation à une campagne", "participations à des campagnes"],
  ["project_task_comments", "commentaire", "commentaires"],
  ["project_idea_comments", "commentaire d'idée", "commentaires d'idées"],
];
// Détails techniques comptés mais non énumérés (ils suivent leur parent).
const QUIET = new Set(["portal_sessions", "project_activity", "project_onboarding_items", "project_onboarding_decks", "mail_attachments",
  "diagnostic_questions", "diagnostic_versions", "participant_actions"]);

/** « 5 tâches du projet, 2 idées » ; liste vide si rien ne part avec l'élément. */
export function summaryParts(summary: Record<string, number> | null | undefined): string[] {
  const s = summary ?? {};
  const out: string[] = [];
  for (const [t, one, many] of TABLES) {
    const n = s[t] ?? 0;
    if (n > 0) out.push(`${n} ${n > 1 ? many : one}`);
  }
  const other = Object.entries(s).filter(([t]) => !TABLES.some(([x]) => x === t) && !QUIET.has(t)).reduce((a, [, n]) => a + n, 0);
  if (other > 0) out.push(`${other} autre${other > 1 ? "s" : ""} élément${other > 1 ? "s" : ""} lié${other > 1 ? "s" : ""}`);
  return out;
}

export type TrashPreview = {
  kind: TrashKind;
  label: string;
  context: string | null;
  warnings: string[];
  summary: Record<string, number>;
};

export type TrashItem = {
  id: string;
  kind: TrashKind;
  label: string;
  context: string | null;
  summary: Record<string, number>;
  actor: "user" | "claude";
  deleted_at: string;
  purge_after: string;
  purge_error: string | null;
  /** Jours restants avant la purge automatique, calculés à la lecture. */
  days_left: number;
};

export type RestoreResult =
  | { restored: true; trash_id: string; label: string; kind: TrashKind; row_table: string; row_id: string }
  | { restored: false; already: true }
  | { restored: false; needs_parent: { trash_id: string; label: string; kind: TrashKind }; label: string; kind: TrashKind };

/** Jours restants avant la purge automatique (0 = purgé au prochain passage). */
export function daysLeft(purgeAfter: string, now = Date.now()) {
  return Math.max(0, Math.ceil((Date.parse(purgeAfter) - now) / 86_400_000));
}
