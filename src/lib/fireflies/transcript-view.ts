// Affichage d'une transcription : formats, recherche et texte copié. Aucune dépendance au navigateur.
import type { Call, CallSummary, TranscriptLine } from "./types";

export function formatOffset(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatCallDuration(minutes: number | null): string {
  if (minutes === null || minutes < 0) return "";
  const total = Math.round(minutes);
  if (total < 1) return "moins d'1 min";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;
}

/** Texte complet, quel que soit le nombre de lignes affichées à l'écran. */
export function transcriptToText(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${formatOffset(l.start)}] ${l.speaker ?? "Intervenant inconnu"} : ${l.text}`).join("\n");
}

/** Sans accents ni majuscules, caractère par caractère : les positions restent celles du texte d'origine. */
export function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const f = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += f.length === 1 ? f : c.toLowerCase().length === 1 ? c.toLowerCase() : c;
  }
  return out;
}

export type TextPart = { text: string; match: boolean };

/** Découpe pour surligner : le texte reste en texte, jamais interprété comme du HTML. */
export function splitMatches(text: string, query: string): TextPart[] {
  const q = fold(query.trim());
  if (!q) return [{ text, match: false }];
  const hay = fold(text);
  const parts: TextPart[] = [];
  let from = 0;
  for (let at = hay.indexOf(q); at !== -1; at = hay.indexOf(q, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + q.length), match: true });
    from = at + q.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/** Positions des lignes qui contiennent la recherche, sur toute la transcription. */
export function findMatchingLines(lines: TranscriptLine[], query: string): number[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (fold(l.text).includes(q)) out.push(i);
  });
  return out;
}

const asText = (v: string | string[] | undefined): string | null => {
  if (!v) return null;
  const t = Array.isArray(v) ? v.join("\n") : v;
  return t.trim() || null;
};

export const summaryText = (s: CallSummary) => asText(s.overview) ?? asText(s.short_summary) ?? asText(s.short_overview) ?? asText(s.gist);
export const shortDescription = (s: CallSummary) => asText(s.gist) ?? asText(s.short_summary) ?? asText(s.short_overview) ?? asText(s.overview);
export const actionItems = (s: CallSummary) => asText(s.action_items);
export const keyPoints = (s: CallSummary) => asText(s.shorthand_bullet) ?? asText(s.bullet_gist);

/** Noms des intervenants, sinon participants invités, sinon adresses. */
export function mainParticipants(c: Pick<Call, "speakers" | "attendees" | "participants">, max = 3): { shown: string[]; more: number } {
  const names = c.speakers.map((s) => s.name);
  const all = names.length ? names : c.attendees.map((a) => a.name ?? a.email ?? "").filter(Boolean);
  const list = all.length ? all : c.participants;
  const unique = [...new Set(list)];
  return { shown: unique.slice(0, max), more: Math.max(0, unique.length - max) };
}
