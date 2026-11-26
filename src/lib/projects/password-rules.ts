// Règles de robustesse du mot de passe du portail : affichées avant la saisie, vérifiées par le serveur.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const PASSWORD_RULES = [`${PASSWORD_MIN} caractères au minimum`, "au moins une lettre", "au moins un chiffre"];

/** Premier manquement aux règles, ou `null` si le mot de passe convient. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  if (password.length > PASSWORD_MAX) return `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX} caractères.`;
  if (!/\p{L}/u.test(password)) return "Le mot de passe doit contenir au moins une lettre.";
  if (!/\p{N}/u.test(password)) return "Le mot de passe doit contenir au moins un chiffre.";
  return null;
}
