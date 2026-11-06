import "server-only";
// Configuration Fireflies, lue uniquement côté serveur. Une variable absente désactive la fonction
// concernée et l'écran de suivi l'indique.

export const firefliesApiKey = () => process.env.FIREFLIES_API_KEY || null;

export function firefliesWebhookSecret(): string | null {
  const s = process.env.FIREFLIES_WEBHOOK_SECRET;
  return s && s.length >= 16 ? s : null;
}
