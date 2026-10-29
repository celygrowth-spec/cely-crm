// Miroir TypeScript des fonctions SQL de normalisation (supabase/migrations/…_schema.sql).
// Sert à regrouper les lignes d'un import avant l'envoi au serveur, qui refait toujours
// ses propres contrôles. Un test vérifie que les deux implémentations concordent.

export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr",
  "msn.com", "yahoo.com", "yahoo.fr", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.fr", "gmx.de", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr",
  "laposte.net", "bbox.fr", "neuf.fr", "numericable.fr", "yandex.com", "yandex.ru", "zoho.com", "mail.com", "hey.com",
]);

const LEGAL_WORDS = new Set([
  "sas", "sasu", "sarl", "sa", "eurl", "sci", "scop", "snc", "inc", "ltd", "llc", "gmbh", "bv", "srl", "spa", "plc",
  "corp", "co", "company", "group", "groupe", "the", "le", "la", "les",
]);

const unaccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae");

export function normEmail(v?: string | null): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return s || null;
}

export function normDomain(v?: string | null): string | null {
  let s = (v ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^/@]*@/, "");
  s = s.replace(/[/?#].*$/, "");
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\d*\./, "");
  s = s.replace(/\.+$/, "");
  return s && s.includes(".") ? s : null;
}

export function emailDomain(v?: string | null): string | null {
  const e = normEmail(v);
  if (!e) return null;
  return e.split("@")[1] || null;
}

export function isFreeEmailDomain(d?: string | null): boolean {
  return FREE_EMAIL_DOMAINS.has((d ?? "").toLowerCase());
}

export function normLinkedin(v?: string | null): string | null {
  let s = (v ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/^([a-z]{2,3}|www|m)\.linkedin\.com/, "linkedin.com");
  s = s.replace(/\/+$/, "");
  return s || null;
}

export function normCompanyName(v?: string | null): string | null {
  let s = unaccent((v ?? "").trim()).toLowerCase();
  s = s.replace(/&/g, " et ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  const words = s.split(" ").filter((w) => w && !LEGAL_WORDS.has(w));
  const out = words.join(" ");
  return out || null;
}

export function normPersonName(first?: string | null, last?: string | null): string | null {
  const s = unaccent(`${first ?? ""} ${last ?? ""}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Domaine d'entreprise exploitable pour regrouper : site web, sinon email professionnel. */
export function companyKeyDomain(website?: string | null, email?: string | null): string | null {
  const d = normDomain(website);
  if (d) return d;
  const ed = emailDomain(email);
  return ed && !isFreeEmailDomain(ed) ? ed : null;
}
