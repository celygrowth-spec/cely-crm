// Règles partagées navigateur / serveur (le bucket les applique aussi de son côté).
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const FILE_CATEGORIES = ["Proposition", "Contrat", "Brief", "Présentation", "Autre"] as const;
export const ALLOWED_TYPES = [
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "application/zip",
];
export const ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip";
export const FORMATS_LABEL = "PDF, images, Word, Excel, PowerPoint, TXT, CSV, ZIP · 25 Mo maximum";
export const isAllowedType = (t: string) => ALLOWED_TYPES.includes(t);
export const isPreviewable = (t: string) => t === "application/pdf" || t.startsWith("image/");
export function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}
