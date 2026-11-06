// Conversion d'une réponse Fireflies vers ce que la base enregistre. Tout est du contenu non fiable :
// seuls des textes nettoyés sont conservés, et l'ordre d'origine des lignes n'est jamais modifié.
import { z } from "zod";

export type TranscriptLine = {
  index: number;
  speaker: string | null;
  speaker_id: string | null;
  text: string;
  start: number | null;
  end: number | null;
};

export type SummaryState = "pending" | "available" | "unavailable";

export type NormalizedCall = {
  fireflies_id: string;
  title: string;
  occurred_at: string | null;
  duration_minutes: number | null;
  organizer_email: string | null;
  participants: string[];
  attendees: { name: string | null; email: string | null }[];
  speakers: { id: string | null; name: string }[];
  transcript_url: string | null;
  meeting_link: string | null;
  calendar_event_id: string | null;
  calendar_type: string | null;
  silent: boolean;
  summary: Record<string, string | string[]>;
  summary_state: SummaryState;
  summary_status: string | null;
  line_count: number;
};

/** Texte accepté par Postgres : ni caractère nul (refusé par jsonb), ni surrogate isolé. */
function clean(s: string): string {
  return s.replace(/\u0000/g, "").toWellFormed();
}
const trimmed = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = clean(s).trim();
  return t || null;
};
const numberOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const text = z.string().nullish().catch(null);
const flexibleText = z.union([z.string(), z.array(z.string())]).nullish().catch(null);

export const transcriptSchema = z.object({
  id: z.string().min(1),
  title: text,
  date: z.union([z.number(), z.string()]).nullish().catch(null),
  dateString: text,
  duration: z.union([z.number(), z.string()]).nullish().catch(null),
  organizer_email: text,
  participants: z.array(z.string().nullable()).nullish().catch(null),
  meeting_attendees: z
    .array(z.object({ displayName: text, email: text, name: text }).nullable())
    .nullish()
    .catch(null),
  speakers: z.array(z.object({ id: z.union([z.string(), z.number()]).nullish(), name: text }).nullable()).nullish().catch(null),
  transcript_url: text,
  meeting_link: text,
  cal_id: text,
  calendar_type: text,
  is_live: z.boolean().nullish().catch(null),
  meeting_info: z.object({ silent_meeting: z.boolean().nullish(), summary_status: text }).nullish().catch(null),
  // Pas de « catch » sur les lignes : une ligne illisible doit échouer plutôt que disparaître en silence.
  sentences: z
    .array(
      z.object({
        index: z.number().nullish(),
        speaker_name: z.string().nullish(),
        speaker_id: z.union([z.string(), z.number()]).nullish(),
        text: z.string().nullish(),
        raw_text: z.string().nullish(),
        start_time: z.union([z.number(), z.string()]).nullish(),
        end_time: z.union([z.number(), z.string()]).nullish(),
      }),
    )
    .nullish(),
  summary: z
    .object({
      gist: flexibleText,
      overview: flexibleText,
      short_summary: flexibleText,
      short_overview: flexibleText,
      action_items: flexibleText,
      keywords: flexibleText,
      outline: flexibleText,
      shorthand_bullet: flexibleText,
      bullet_gist: flexibleText,
      meeting_type: flexibleText,
      topics_discussed: flexibleText,
    })
    .nullish()
    .catch(null),
});
export type RawTranscript = z.infer<typeof transcriptSchema>;

/** Seul un lien https vers fireflies.ai devient un bouton : une réponse altérée ne peut pas glisser un autre lien. */
export function safeTranscriptUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return host === "fireflies.ai" || host.endsWith(".fireflies.ai") ? u.toString() : null;
  } catch {
    return null;
  }
}

function occurredAt(raw: RawTranscript): string | null {
  const ms = numberOrNull(raw.date);
  const d = ms !== null ? new Date(ms) : raw.dateString ? new Date(raw.dateString) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

const validEmail = (s: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

/** participants contient des adresses, parfois regroupées dans une même chaîne séparée par des virgules. */
function participantEmails(raw: RawTranscript): string[] {
  const all = (raw.participants ?? [])
    .flatMap((p) => (p ?? "").split(/[,;]/))
    .concat((raw.meeting_attendees ?? []).map((a) => a?.email ?? ""))
    .map((p) => clean(p).trim().toLowerCase())
    .filter(validEmail);
  return [...new Set(all)];
}

function summaryOf(raw: RawTranscript): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw.summary ?? {})) {
    if (typeof v === "string") {
      const t = trimmed(v);
      if (t) out[k] = t;
    } else if (Array.isArray(v)) {
      const list = v.map(trimmed).filter((x): x is string => !!x);
      if (list.length) out[k] = list;
    }
  }
  return out;
}

export class IncompleteTranscript extends Error {}

export function normalizeTranscript(input: unknown): { call: NormalizedCall; lines: TranscriptLine[] } {
  const raw = transcriptSchema.parse(input);
  const silent = raw.meeting_info?.silent_meeting === true;
  const sentences = raw.sentences ?? [];
  // Pendant la réunion, Fireflies renvoie des sous-titres en direct : surtout pas à conserver comme version finale.
  if (raw.is_live) throw new IncompleteTranscript("Réunion encore en cours chez Fireflies.");
  if (!sentences.length && !silent) throw new IncompleteTranscript("Transcription vide alors que la réunion n'est pas silencieuse.");

  const lines: TranscriptLine[] = sentences.map((s, i) => ({
    index: s.index ?? i,
    speaker: trimmed(s.speaker_name),
    speaker_id: s.speaker_id === null || s.speaker_id === undefined ? null : String(s.speaker_id),
    text: clean(s.text ?? s.raw_text ?? ""),
    start: numberOrNull(s.start_time),
    end: numberOrNull(s.end_time),
  }));

  const summary = summaryOf(raw);
  const status = raw.meeting_info?.summary_status ?? null;
  const textual = Object.keys(summary).some((k) => k !== "meeting_type" && k !== "keywords");
  // « processed » sans texte ou « failed » / « skipped » : rien de plus à attendre.
  const summary_state: SummaryState = textual
    ? status === "processing" ? "pending" : "available"
    : silent || status === "failed" || status === "skipped" || status === "processed"
      ? "unavailable"
      : "pending";

  return {
    lines,
    call: {
      fireflies_id: raw.id,
      title: (trimmed(raw.title) ?? "Appel sans titre").slice(0, 500),
      occurred_at: occurredAt(raw),
      duration_minutes: (() => {
        const d = numberOrNull(raw.duration);
        return d !== null && d >= 0 ? d : null;
      })(),
      organizer_email: trimmed(raw.organizer_email)?.toLowerCase() ?? null,
      participants: participantEmails(raw),
      attendees: (raw.meeting_attendees ?? []).flatMap((a) => {
        const name = trimmed(a?.displayName) ?? trimmed(a?.name);
        const email = trimmed(a?.email)?.toLowerCase() ?? null;
        return name || email ? [{ name, email }] : [];
      }),
      speakers: (raw.speakers ?? []).flatMap((s) => {
        const name = trimmed(s?.name);
        return name ? [{ id: s?.id === null || s?.id === undefined ? null : String(s.id), name }] : [];
      }),
      transcript_url: safeTranscriptUrl(raw.transcript_url),
      meeting_link: trimmed(raw.meeting_link),
      // cal_id : identifiant de cette occurrence chez Google. calendar_id désigne toute une série récurrente.
      calendar_event_id: trimmed(raw.cal_id),
      calendar_type: trimmed(raw.calendar_type),
      silent,
      summary,
      summary_state,
      summary_status: status,
      line_count: lines.length,
    },
  };
}
