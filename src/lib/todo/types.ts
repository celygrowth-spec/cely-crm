// Productivité › To do list : types, libellés et ordre d'affichage (sans dépendance au navigateur ni au serveur).

export const URGENCIES = ["urgent", "moyen", "pas_urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];
export const DEFAULT_URGENCY: Urgency = "moyen";

export const URGENCY_LABEL: Record<Urgency, string> = {
  urgent: "Urgent",
  moyen: "Moyen",
  pas_urgent: "Pas urgent",
};

export type TodoItem = {
  id: string;
  title: string;
  urgency: Urgency;
  company_id: string | null;
  /** Nom de la fiche liée ; null si elle n'est plus lisible (à la corbeille) ou s'il n'y a pas de fiche. */
  company_name: string | null;
  company_archived: boolean;
  done_at: string | null;
  created_at: string;
};

const RANK: Record<Urgency, number> = { urgent: 0, moyen: 1, pas_urgent: 2 };

/** Tâches ouvertes : Urgent, puis Moyen, puis Pas urgent ; à urgence égale, la plus récente d'abord. */
export function sortOpen(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

/** Tâches terminées : la dernière terminée d'abord. */
export function sortDone(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? "") || b.created_at.localeCompare(a.created_at));
}

/** Sépare et trie les tâches ouvertes et terminées. */
export function splitTodos(items: TodoItem[]) {
  return { open: sortOpen(items.filter((t) => !t.done_at)), done: sortDone(items.filter((t) => !!t.done_at)) };
}
