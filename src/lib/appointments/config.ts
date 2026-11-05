import "server-only";
// Configuration externe du module Rendez-vous. Rien n'est simulé : une variable absente
// désactive la fonctionnalité concernée et l'interface l'indique.

export function appointmentsSecretOrNull(): string | null {
  const s = process.env.APPOINTMENTS_SECRET;
  return s && s.length >= 32 ? s : null;
}

export function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Adresse publique de l'application (liens privés, retour OAuth). */
export function appUrl(requestOrigin?: string | null): string {
  const fromEnv = process.env.APP_URL?.replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (requestOrigin) return requestOrigin.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

export type ConfigStatus = { secret: boolean; google: boolean; appUrl: string | null };

export function configStatus(): ConfigStatus {
  return { secret: appointmentsSecretOrNull() !== null, google: googleConfig() !== null, appUrl: process.env.APP_URL ?? null };
}
