import "server-only";
// Client GraphQL Fireflies, côté serveur uniquement. Les messages d'erreur conservés sont les nôtres :
// ceux de l'API ne sont ni journalisés ni enregistrés, ils peuvent citer du contenu.
import { firefliesApiKey } from "./config";

const ENDPOINT = "https://api.fireflies.ai/graphql";
const TIMEOUT_MS = 25_000;

export type FailureKind = "temporary" | "rate_limited" | "permanent";

export class FirefliesFailure extends Error {
  constructor(readonly kind: FailureKind, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

// Champs communs aux pages « transcript » et « schema/summary » de la doc : un champ inconnu ferait échouer toute la requête.
const TRANSCRIPT_QUERY = `query CrmTranscript($id: String!) {
  user { user_id email }
  transcript(id: $id) {
    id title date dateString duration organizer_email participants transcript_url meeting_link
    cal_id calendar_type is_live
    speakers { id name }
    meeting_attendees { displayName email name }
    meeting_info { silent_meeting summary_status }
    summary { gist overview short_summary short_overview action_items keywords outline shorthand_bullet bullet_gist meeting_type topics_discussed }
    sentences { index speaker_name speaker_id text raw_text start_time end_time }
  }
}`;

const LIST_QUERY = `query CrmTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip, mine: true) { id }
}`;

const MESSAGES: Record<string, [FailureKind, string]> = {
  too_many_requests: ["rate_limited", "Quota de l'API Fireflies atteint : reprise automatique plus tard."],
  request_timeout: ["temporary", "Fireflies n'a pas répondu à temps."],
  invariant_violation: ["temporary", "Erreur interne de Fireflies."],
  object_not_found: ["permanent", "Cet appel n'existe pas chez Fireflies ou ce compte n'y a pas accès."],
  forbidden: ["permanent", "Fireflies refuse l'accès à cet appel."],
  paid_required: ["permanent", "Cette donnée demande un forfait Fireflies supérieur."],
  account_cancelled: ["permanent", "Le compte Fireflies est résilié."],
  feature_disabled: ["permanent", "Cette fonction est désactivée par l'administrateur Fireflies."],
  require_elevated_privilege: ["permanent", "Il faut un compte administrateur Fireflies."],
  not_in_team: ["permanent", "Cet utilisateur n'est pas dans l'équipe Fireflies."],
  invalid_arguments: ["permanent", "Requête refusée par Fireflies."],
  args_required: ["permanent", "Requête refusée par Fireflies."],
};

type GraphQlError = { code?: string; message?: string; extensions?: { code?: string; metadata?: { retryAfter?: number } } };

function retryAfterSeconds(res: Response, err?: GraphQlError): number | undefined {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const meta = Number(err?.extensions?.metadata?.retryAfter);
  return Number.isFinite(meta) && meta > 0 ? Math.ceil(meta) : undefined;
}

function failureFor(code: string, retryAfter?: number): FirefliesFailure {
  const known = MESSAGES[code];
  if (known) return new FirefliesFailure(known[0], code, known[1], retryAfter);
  return new FirefliesFailure("temporary", "unknown", "Réponse inattendue de Fireflies.");
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T; errors: GraphQlError[] }> {
  const key = firefliesApiKey();
  if (!key) throw new FirefliesFailure("temporary", "not_configured", "Clé API Fireflies absente (FIREFLIES_API_KEY).");
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new FirefliesFailure("temporary", "network", "Fireflies est injoignable.");
  }
  if (res.status === 401) throw new FirefliesFailure("temporary", "auth", "Clé API Fireflies refusée : vérifiez FIREFLIES_API_KEY.");
  let body: { data?: T; errors?: GraphQlError[] } | null = null;
  try {
    body = await res.json();
  } catch {
    // corps illisible : traité plus bas d'après le statut
  }
  const errors = body?.errors ?? [];
  if (res.status === 429) throw new FirefliesFailure("rate_limited", "too_many_requests", MESSAGES.too_many_requests[1], retryAfterSeconds(res, errors[0]));
  if (res.status >= 500 && !body?.data) throw new FirefliesFailure("temporary", `http_${res.status}`, "Fireflies est momentanément indisponible.");
  if (!body?.data) {
    const code = errors[0]?.code ?? errors[0]?.extensions?.code ?? `http_${res.status}`;
    throw failureFor(code, retryAfterSeconds(res, errors[0]));
  }
  return { data: body.data, errors };
}

export type FetchedTranscript = { account: { id: string; email: string | null }; transcript: unknown };

export async function fetchTranscript(id: string): Promise<FetchedTranscript> {
  const { data, errors } = await graphql<{
    user?: { user_id?: string | null; email?: string | null } | null;
    transcript?: unknown;
  }>(TRANSCRIPT_QUERY, { id });
  if (!data.transcript) {
    const code = errors[0]?.code ?? errors[0]?.extensions?.code ?? "object_not_found";
    throw failureFor(code);
  }
  if (!data.user?.user_id) throw new FirefliesFailure("temporary", "account", "Compte Fireflies illisible.");
  return { account: { id: data.user.user_id, email: data.user.email ?? null }, transcript: data.transcript };
}

export async function listTranscriptIds(from: Date, to: Date, skip: number, limit: number): Promise<string[]> {
  const { data, errors } = await graphql<{ transcripts?: { id?: string }[] | null }>(LIST_QUERY, {
    fromDate: from.toISOString(),
    toDate: to.toISOString(),
    limit,
    skip,
  });
  if (!data.transcripts) throw failureFor(errors[0]?.code ?? errors[0]?.extensions?.code ?? "unknown");
  return data.transcripts.map((t) => t.id).filter((id): id is string => !!id);
}
