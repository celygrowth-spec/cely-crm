// « Comment m'avez-vous connu ? » : liste courte commune à la réservation publique et aux formulaires du site.
// La réponse est facultative et s'affiche dans la fiche à côté de la source mesurée.
export const DECLARED_SOURCES = [
  "Recherche Google",
  "LinkedIn",
  "ChatGPT ou une autre IA",
  "Recommandation",
  "Email reçu",
  "Événement",
  "Autre",
] as const;
export type DeclaredSource = (typeof DECLARED_SOURCES)[number];

/** Source mesurée correspondante, pour comparer ce qui est déclaré à ce qui est mesuré. */
export const DECLARED_CHANNEL: Record<DeclaredSource, string | null> = {
  "Recherche Google": "organic",
  LinkedIn: "social",
  "ChatGPT ou une autre IA": "ai",
  Recommandation: null,
  "Email reçu": "email",
  "Événement": null,
  Autre: null,
};
