// Connecteur Make : règles pures (navigateur, serveur et tests). Aucune adresse ni secret ici.
import { z } from "zod";

/** Scénario attendu par le générateur de proposition. Les autres s'ajoutent librement. */
export const QUOTE_SCENARIO = { key: "creer_le_devis", name: "Créer le devis" } as const;

export const RETURN_EVENTS = ["quote.created", "quote.sent", "quote.signed", "quote.error"] as const;
export type ReturnEvent = (typeof RETURN_EVENTS)[number];

export type MakeScenario = { id: string; key: string; name: string; updated_at: string };
export type MakeCall = { id: number; at: string; direction: "out" | "in"; scenario: string | null; event: string; status: "ok" | "error" | "duplicate" | "ignored" | "refused" | "invalid"; error: string | null };
export type MakeDetail = { scenarios: MakeScenario[]; calls: MakeCall[]; callbackUrl: string; secretPresent: boolean; serverReady: boolean };

export const CALL_STATUS_LABEL: Record<MakeCall["status"], string> = {
  ok: "Réussi", error: "Échec", duplicate: "Déjà reçu", ignored: "Ignoré", refused: "Refusé", invalid: "Contenu refusé",
};
export const EVENT_LABEL: Record<string, string> = {
  test: "Test de connexion", "quote.create": "Création du devis", "quote.created": "Devis créé", "quote.sent": "Devis envoyé",
  "quote.signed": "Devis signé", "quote.error": "Erreur du scénario",
};

/** Identifiant stable d'un scénario, tiré de son nom : « Créer le devis » → « creer_le_devis ». */
export function scenarioKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// Adresse d'un webhook Make (toutes zones). Une autre adresse n'est acceptée que si elle commence par
// l'origine de test fournie (faux serveur local ou webhook de recette) : jamais d'appel vers un hôte arbitraire.
const MAKE_HOOK = /^https:\/\/hook\.(?:[a-z0-9-]+\.)?(?:make\.com|integromat\.com|make\.celonis\.com)\/[A-Za-z0-9_-]{8,200}$/;

export function webhookAllowed(url: string, testOrigin?: string | null): boolean {
  if (url.length > 500 || /\s/.test(url)) return false;
  if (MAKE_HOOK.test(url)) return true;
  const origin = testOrigin?.trim().replace(/\/+$/, "");
  return !!origin && /^https?:\/\/[^/?#]+$/.test(origin) && (url === origin || url.startsWith(`${origin}/`));
}

// Make envoie souvent une chaîne vide ou null pour un champ non renseigné : traité comme absent.
const blank = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === "" || v === null ? undefined : v), s.optional());

/** Retour de Make : rien d'autre que ces champs n'est accepté. */
export const returnSchema = z.strictObject({
  event: z.enum(RETURN_EVENTS),
  request_id: z.uuid(),
  quote: blank(z.strictObject({
    number: blank(z.string().trim().min(1).max(60)),
    url: blank(z.string().max(500).regex(/^https:\/\/[^\s]+$/)),
    signed_at: blank(z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((s) => s.slice(0, 10)).refine((d) => !Number.isNaN(Date.parse(d)))),
  })),
  error: blank(z.strictObject({ message: blank(z.string().trim().max(300)) })),
});
export type MakeReturn = z.infer<typeof returnSchema>;
