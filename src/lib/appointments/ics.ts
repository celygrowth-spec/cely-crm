// Fichier iCalendar (RFC 5545) d'un rendez-vous : UID stable et SEQUENCE = version, pour qu'un
// fichier téléchargé après un report remplace l'ancien dans l'agenda du visiteur.

export type IcsInput = {
  uid: string;
  sequence: number;
  start: string;
  end: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  cancelled?: boolean;
  now?: Date;
};

const utc = (iso: string | Date) =>
  new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Échappement des valeurs texte (virgule, point-virgule, antislash, retours à la ligne). */
export function icsEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Repli des lignes à 75 octets (UTF-8), suite précédée d'une espace. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) {
      out.push(cur);
      cur = ch;
      limit = 74;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(e: IcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cely Growth//Rendez-vous//FR",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${utc(e.now ?? new Date())}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${icsEscape(e.summary)}`,
    e.description ? `DESCRIPTION:${icsEscape(e.description)}` : null,
    e.location ? `LOCATION:${icsEscape(e.location)}` : null,
    e.url ? `URL:${e.url}` : null,
    `STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Lien « Ajouter à Google Agenda » (modèle d'événement, aucune autorisation requise). */
export function googleCalendarTemplateUrl(e: { start: string; end: string; summary: string; details?: string | null; location?: string | null }) {
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.summary, dates: `${utc(e.start)}/${utc(e.end)}` });
  if (e.details) p.set("details", e.details);
  if (e.location) p.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
