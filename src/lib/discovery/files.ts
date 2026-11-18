// Fichiers de l'onboarding : type déduit de l'extension (le navigateur annonce parfois « application/x-zip-compressed »
// ou rien du tout), limites affichées. Les limites qui comptent sont appliquées en base (discovery_private.file_rules).
const MIME: Record<string, string> = {
  csv: "text/csv", txt: "text/plain", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFromName(name: string): string | null {
  const ext = name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase();
  return (ext && MIME[ext]) || null;
}

export type UploadStep = "blacklist" | "linkedin" | "documents";
export const STEP_FILES: Record<UploadStep, { accept: string; label: string; max: number }> = {
  blacklist: { accept: ".csv,.xls,.xlsx,.txt", label: "CSV ou Excel · 50 Mo maximum", max: 50 * 1024 * 1024 },
  linkedin: { accept: ".zip", label: "Fichier ZIP de LinkedIn · 1 Go maximum", max: 1024 * 1024 * 1024 },
  documents: { accept: ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip", label: "PDF, PowerPoint, Word, Excel, images, ZIP · 100 Mo maximum", max: 100 * 1024 * 1024 },
};

export function acceptedFor(step: UploadStep, name: string): boolean {
  const ext = name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  return STEP_FILES[step].accept.split(",").includes(`.${ext}`);
}
