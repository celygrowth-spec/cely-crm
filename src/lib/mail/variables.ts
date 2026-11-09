// Variables d'un email : stockées dans le HTML sous la forme <span data-variable="prenom">Prénom</span>
// (pastille dans l'éditeur), {{prenom}} dans l'objet. Résolues avec le contact de référence ; une valeur
// absente n'est JAMAIS remplacée en silence : elle est signalée et bloque l'envoi.
import { VARIABLES, type VariableKey } from "@/lib/prospection/steps";
import { escapeHtml } from "./render";

export { VARIABLES };
export type { VariableKey };
/** Variables propres à une personne : sans objet dans une formule collective. */
export const PERSON_KEYS: VariableKey[] = ["prenom", "nom", "poste"];
export const isKnown = (k: string): k is VariableKey => VARIABLES.some((v) => v.key === k);
export const labelOf = (k: string) => VARIABLES.find((v) => v.key === k)?.label ?? k;

export type VarContext = {
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  company?: string | null;
  website?: string | null;
};

export const varSpan = (key: VariableKey) => `<span data-variable="${key}">${escapeHtml(labelOf(key))}</span>`;

const SPAN = /<span[^>]*data-variable="([a-z_]+)"[^>]*>[\s\S]*?<\/span>/g;
const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/** {{prenom}} saisi ou issu d'un ancien modèle → pastille de variable. */
export const tokensToSpans = (html: string) => html.replace(TOKEN, (t, k: string) => (isKnown(k.toLowerCase()) ? varSpan(k.toLowerCase() as VariableKey) : t));

export function usedVariables(html: string, subject = ""): VariableKey[] {
  const keys = new Set<string>();
  for (const m of html.matchAll(SPAN)) keys.add(m[1]);
  for (const m of subject.matchAll(TOKEN)) keys.add(m[1].toLowerCase());
  return [...keys].filter(isKnown);
}

export function valueOf(key: VariableKey, ctx: VarContext, collective: boolean): string | null {
  if (collective && PERSON_KEYS.includes(key)) return null;
  const v = { prenom: ctx.first_name, nom: ctx.last_name, poste: ctx.title, entreprise: ctx.company, site: ctx.website }[key];
  const s = (v ?? "").trim();
  return s ? s : null;
}

export type Resolved = { html: string; subject: string; missing: VariableKey[] };

/** Remplace les variables connues ; les absentes restent en place et sont listées dans `missing`. */
export function resolveVariables(html: string, subject: string, ctx: VarContext, collective: boolean): Resolved {
  const missing = new Set<VariableKey>();
  const pick = (k: string, keep: string) => {
    if (!isKnown(k)) return keep;
    const v = valueOf(k, ctx, collective);
    if (v == null) {
      missing.add(k);
      return keep;
    }
    return v;
  };
  const outHtml = html.replace(SPAN, (whole, k: string) => {
    const v = pick(k, "");
    return v ? escapeHtml(v) : whole;
  });
  const outSubject = subject.replace(TOKEN, (whole, k: string) => pick(k.toLowerCase(), whole));
  return { html: outHtml, subject: outSubject, missing: [...missing] };
}

/** Remplace (ou retire, avec "") toutes les occurrences d'une variable, dans le HTML et l'objet. */
export function replaceVariable(html: string, subject: string, key: VariableKey, text: string) {
  return {
    html: html.replace(new RegExp(`<span[^>]*data-variable="${key}"[^>]*>[\\s\\S]*?<\\/span>`, "g"), escapeHtml(text)),
    subject: subject.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi"), text),
  };
}

export type Scrub = { key: VariableKey; value: string; count: number };

/**
 * « Enregistrer comme modèle » : repère, dans le texte (jamais dans les balises), les informations propres
 * au prospect et propose de les remplacer par des variables. `apply` limite aux clés acceptées.
 */
export function scrubProspect(html: string, subject: string, ctx: VarContext, apply?: VariableKey[]): { html: string; subject: string; found: Scrub[] } {
  const pairs = (["entreprise", "site", "prenom", "nom", "poste"] as VariableKey[])
    .map((key) => ({ key, value: valueOf(key, ctx, false) }))
    .filter((p): p is { key: VariableKey; value: string } => !!p.value && p.value.length >= 2)
    .sort((a, b) => b.value.length - a.value.length); // les plus longues d'abord (« Studio Démo » avant « Démo »)
  const counts = new Map<VariableKey, number>();
  const re = (v: string) => new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
  const doText = (t: string, spans: boolean) => {
    let out = t;
    for (const { key, value } of pairs) {
      const r = re(escapeHtml(value));
      const n = (out.match(r) ?? []).length;
      if (!n) continue;
      counts.set(key, (counts.get(key) ?? 0) + n);
      if (!apply || apply.includes(key)) out = out.replace(r, spans ? varSpan(key) : `{{${key}}}`);
    }
    return out;
  };
  // texte entre les balises seulement, et jamais à l'intérieur d'une pastille existante
  const outHtml = html.split(/(<[^>]+>)/).reduce<{ out: string; inVar: number }>((acc, part) => {
    if (part.startsWith("<")) {
      if (/^<span[^>]*data-variable/.test(part)) acc.inVar++;
      else if (part === "</span>" && acc.inVar) acc.inVar--;
      acc.out += part;
    } else acc.out += acc.inVar ? part : doText(part, true);
    return acc;
  }, { out: "", inVar: 0 }).out;
  const outSubject = doText(subject, false);
  return { html: outHtml, subject: outSubject, found: [...counts.entries()].map(([key, count]) => ({ key, value: valueOf(key, ctx, false)!, count })) };
}
