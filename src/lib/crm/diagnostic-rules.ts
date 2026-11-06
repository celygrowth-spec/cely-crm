// Règles partagées navigateur / serveur du dossier de diagnostic.
export const CLAUDE_NEW_CHAT = "https://claude.ai/new";
export const LIBRARY_BUCKET = "diagnostic-library";
export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const MAX_LIBRARY_BYTES = 25 * 1024 * 1024;

export const LIBRARY_CATEGORIES = { example: "Diagnostic d'exemple", brand: "Marque et design", guide: "Méthode", other: "Autre" } as const;
export type LibraryCategory = keyof typeof LIBRARY_CATEGORIES;

// Certains navigateurs ne renseignent pas le type des fichiers .md, .html ou .svg : l'extension fait foi.
const LIBRARY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pptx: PPTX_TYPE,
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
};
export const LIBRARY_ACCEPT = Object.keys(LIBRARY_TYPES).map((e) => `.${e}`).join(",");
export const libraryType = (name: string): string | null => LIBRARY_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;

export type DiagnosticStatus = "waiting_claude" | "researching" | "questions_ready" | "answers_sent" | "generating" | "version_ready" | "failed";

export const DIAGNOSTIC_STATUS_LABELS: Record<DiagnosticStatus, string> = {
  waiting_claude: "En attente de Claude",
  researching: "Recherche en cours",
  questions_ready: "Questions à compléter",
  answers_sent: "Réponses envoyées, slides à générer",
  generating: "Génération en cours",
  version_ready: "Fichier reçu",
  failed: "Échec",
};

export type DiagnosticQuestion = { id: string; position: number; question: string; why: string | null; answer: string | null; dont_know: boolean };
export type DiagnosticVersion = { id: string; version: number; file_id: string | null; status: "uploading" | "ready"; created_at: string; ready_at: string | null };
export type DiagnosticSource = { titre: string; url?: string; date?: string; marche?: string; nature: "fait" | "hypothese" | "prospect" };
export type Diagnostic = {
  id: string;
  company_id: string;
  status: DiagnosticStatus;
  chat_url: string | null;
  summary: string | null;
  sources: DiagnosticSource[];
  answers_sent_at: string | null;
  last_error: string | null;
  created_at: string;
  questions: DiagnosticQuestion[];
  versions: DiagnosticVersion[];
};
export type LibraryFile = { id: string; category: LibraryCategory; display_name: string; mime_type: string; size_bytes: number; created_at: string };

// Le lien ne porte que l'identifiant du dossier : Claude lit le reste dans le CRM, avec sa propre autorisation.
export const startPrompt = (id: string) =>
  `Diagnostic Cely, dossier ${id}. Avec le connecteur du CRM, appelle open_diagnostic avec cet identifiant, puis suis les consignes qu'il renvoie.`;
export const answersPrompt = (id: string) =>
  `Diagnostic Cely, dossier ${id} : les réponses sont envoyées. Avec le connecteur du CRM, appelle open_diagnostic avec cet identifiant, lis les réponses, puis génère les slides et dépose la version dans le CRM.`;

/** Dans le chat associé s'il est connu, sinon dans une nouvelle conversation. Un lien de chat n'accepte que claude.ai. */
export function claudeLink(prompt: string, chatUrl?: string | null) {
  const base = chatUrl && /^https:\/\/claude\.ai\//.test(chatUrl) ? chatUrl.split(/[?#]/)[0] : CLAUDE_NEW_CHAT;
  return `${base}?q=${encodeURIComponent(prompt)}`;
}
