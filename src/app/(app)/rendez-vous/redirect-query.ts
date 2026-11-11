/** Adresse cible avec les paramètres d'origine ; `force` remplace ou ajoute des paramètres (placés en tête). */
export function withQuery(path: string, sp: Record<string, string | string[] | undefined>, force: Record<string, string> = {}) {
  const q = new URLSearchParams(force);
  for (const [k, v] of Object.entries(sp)) {
    if (k in force) continue;
    for (const x of [v].flat()) if (x !== undefined) q.append(k, x);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
