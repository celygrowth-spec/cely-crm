// Parcours d'un client, de l'appel à l'onboarding : UNE prochaine action principale, déduite de son état.
// Règles pures, partagées par la fiche, la carte du Pipeline, Appels, Agenda et Aujourd'hui.
// Les étapes ne dépendent d'aucune étape de pipeline : elles se lisent dans les documents (diagnostic, proposition, devis).
export type JourneyRow = {
  company_id: string; name: string; deal_status: "open" | "won" | "lost";
  last_call_at: string | null;
  diagnostic_id: string | null; diagnostic_status: string | null; diagnostic_at: string | null; diagnostic_ready_at: string | null; diagnostic_validated_at: string | null;
  proposal_id: string | null; proposal_at: string | null; proposal_version: number | null; proposal_slides: "pending" | "uploading" | "ready" | "failed" | null;
  proposal_ready_at: string | null; proposal_validated_at: string | null; proposal_sent_at: string | null; proposal_signed_at: string | null;
  project_id: string | null;
  onboarding_id: string | null; onboarding_at: string | null; onboarding_version: number | null; onboarding_slides: "pending" | "uploading" | "ready" | "failed" | null;
  onboarding_ready_at: string | null; onboarding_validated_at: string | null;
};

/** Les états du parcours, dans l'ordre. */
export type JourneyStep = "appel_fait" | "diagnostic" | "diagnostic_valide" | "proposition" | "proposition_envoyee" | "signee" | "onboarding";
export const STEP_LABELS: Record<JourneyStep, string> = {
  appel_fait: "Appel fait", diagnostic: "Diagnostic", diagnostic_valide: "Diagnostic validé", proposition: "Proposition",
  proposition_envoyee: "Proposition envoyée", signee: "Signée", onboarding: "Onboarding",
};

export type JourneyTarget = { kind: "tab"; tab: "diagnostic" | "proposal" } | { kind: "project"; id: string } | { kind: "client" };
export type NextAction = {
  step: JourneyStep;
  /** libellé du bouton */
  label: string;
  /** vrai quand le bouton lance l'action ; faux quand il ouvre un livrable existant (« Voir… ») */
  create: boolean;
  target: JourneyTarget;
  /** action attendue de ma part, datée, pour Aujourd'hui (null : rien à faire de mon côté pour l'instant) */
  todo: { title: string; since: string } | null;
};

const TODAY_CALL_DAYS = 30;

/** La prochaine action principale d'un client, ou null s'il n'est pas (ou plus) dans ce parcours. */
export function nextAction(r: JourneyRow, now = Date.now()): NextAction | null {
  if (r.deal_status === "lost") return null;
  const name = r.name.replace(/^\[TEST\]\s*/, "");
  const todo = (title: string, since: string | null) => ({ title: `${title} ${name}`, since: since ?? new Date(now).toISOString() });
  const tab = (t: "diagnostic" | "proposal"): JourneyTarget => ({ kind: "tab", tab: t });

  // Onboarding : une fois la proposition signée et le client créé
  if (r.onboarding_id && r.project_id) {
    const target: JourneyTarget = { kind: "project", id: r.project_id };
    const base = { step: "onboarding" as const, label: "Voir l'onboarding", create: false, target };
    if (r.onboarding_validated_at) return { ...base, todo: null };
    if (r.onboarding_version == null) return { ...base, todo: todo("Onboarding à préparer pour", r.onboarding_at) };
    if (r.onboarding_slides === "ready") return { ...base, todo: todo("Onboarding à relire pour", r.onboarding_ready_at) };
    if (r.onboarding_slides === "failed") return { ...base, todo: todo("Onboarding à relancer pour", r.onboarding_at) };
    return { ...base, todo: null };
  }
  if (r.proposal_signed_at) {
    if (r.deal_status !== "won" || !r.project_id) return { step: "signee", label: "Passer en client", create: true, target: { kind: "client" }, todo: todo("Passage en client à confirmer pour", r.proposal_signed_at) };
    return { step: "signee", label: "Générer l'onboarding", create: true, target: { kind: "project", id: r.project_id }, todo: todo("Onboarding à préparer pour", r.proposal_signed_at) };
  }
  // un client déjà gagné sans proposition signée n'est pas dans ce parcours (données anciennes)
  if (r.deal_status === "won") return null;

  if (r.proposal_id) {
    const base = { label: "Voir la proposition", create: false, target: tab("proposal") };
    if (r.proposal_sent_at) return { ...base, step: "proposition_envoyee", todo: null };
    if (r.proposal_version == null) return { ...base, step: "proposition", todo: todo("Proposition à préparer pour", r.proposal_at) };
    if (r.proposal_validated_at) return { ...base, step: "proposition", label: "Envoyer la proposition", todo: todo("Proposition à envoyer à", r.proposal_validated_at) };
    if (r.proposal_slides === "ready") return { ...base, step: "proposition", todo: todo("Proposition à relire pour", r.proposal_ready_at) };
    if (r.proposal_slides === "failed") return { ...base, step: "proposition", todo: todo("Proposition à relancer pour", r.proposal_at) };
    return { ...base, step: "proposition", todo: null };
  }
  if (r.diagnostic_validated_at) return { step: "diagnostic_valide", label: "Générer la proposition", create: true, target: tab("proposal"), todo: todo("Proposition à préparer pour", r.diagnostic_validated_at) };
  if (r.diagnostic_id) {
    const base = { step: "diagnostic" as const, label: "Voir le diagnostic", create: false, target: tab("diagnostic") };
    if (r.diagnostic_ready_at) return { ...base, todo: todo("Diagnostic à valider pour", r.diagnostic_ready_at) };
    if (r.diagnostic_status === "questions_ready") return { ...base, todo: todo("Questions du diagnostic à compléter pour", r.diagnostic_at) };
    if (r.diagnostic_status === "failed") return { ...base, todo: todo("Diagnostic à relancer pour", r.diagnostic_at) };
    return { ...base, todo: null };
  }
  if (r.last_call_at) {
    // dans Aujourd'hui, seulement après un appel récent : un vieil appel ne revient pas indéfiniment
    const recent = now - Date.parse(r.last_call_at) <= TODAY_CALL_DAYS * 86_400_000;
    return { step: "appel_fait", label: "Générer un diagnostic", create: true, target: tab("diagnostic"), todo: recent ? todo("Diagnostic à générer pour", r.last_call_at) : null };
  }
  return null;
}

export const ONGLETS = { diagnostic: "diagnostic", proposal: "proposition" } as const;
/** Adresse qui mène à l'action, depuis n'importe quel écran. */
export function actionHref(companyId: string, a: Pick<NextAction, "target" | "create">): string {
  if (a.target.kind === "project") return `/projets/${a.target.id}`;
  if (a.target.kind === "client") return `/fiches/${companyId}?onglet=proposition`;
  // « Générer… » : l'onglet s'ouvre et le générateur démarre ; « Voir… » : l'onglet seul
  return `/fiches/${companyId}?onglet=${ONGLETS[a.target.tab]}${a.create ? "&lancer=1" : ""}`;
}

export type TodoLine = { company_id: string; title: string; since: string; href: string; label: string; step: JourneyStep };
/** Actions datées pour Aujourd'hui, les plus anciennes d'abord. */
export function journeyTodos(rows: JourneyRow[], now = Date.now()): TodoLine[] {
  return rows.flatMap((r) => {
    const a = nextAction(r, now);
    return a?.todo ? [{ company_id: r.company_id, title: a.todo.title, since: a.todo.since, href: actionHref(r.company_id, a), label: a.label, step: a.step }] : [];
  }).sort((a, b) => a.since.localeCompare(b.since));
}
