// Raccourcis de la palette ⌘K : navigation et création, filtrés par le texte saisi.
export type PaletteCommand = { id: string; group: "Aller à…" | "Créer…"; label: string; keywords?: string; href?: string; create?: true };

export const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: "go-today", group: "Aller à…", label: "Aujourd'hui", keywords: "accueil taches relances", href: "/" },
  { id: "go-sales", group: "Aller à…", label: "Ventes", keywords: "gagne", href: "/ventes" },
  { id: "go-projects", group: "Aller à…", label: "Projets", keywords: "clients onboarding", href: "/projets" },
  { id: "go-rdv", group: "Aller à…", label: "Rendez-vous", keywords: "agenda rdv", href: "/rendez-vous" },
  { id: "go-revenue", group: "Aller à…", label: "Finance › Revenus", keywords: "factures argent", href: "/finance/revenus" },
  { id: "go-time", group: "Aller à…", label: "Temps", keywords: "chrono heures", href: "/temps" },
  { id: "go-mail", group: "Aller à…", label: "Mail", keywords: "email gmail", href: "/mail" },
  { id: "go-calls", group: "Aller à…", label: "Appels", keywords: "fireflies", href: "/appels" },
  { id: "go-settings", group: "Aller à…", label: "Paramètres", keywords: "reglages connecteurs", href: "/parametres" },
  { id: "new-company", group: "Créer…", label: "Nouvelle fiche", keywords: "entreprise prospect creer ajouter", create: true },
  // pas de paramètre d'ouverture du formulaire sur /finance/revenus : la page s'ouvre, bouton « Ajouter un revenu » en tête
  { id: "new-revenue", group: "Créer…", label: "Ajouter un revenu", keywords: "finance facture creer nouveau", href: "/finance/revenus" },
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Commandes dont le groupe, le libellé ou les mots-clés contiennent tous les mots saisis (accents ignorés). */
export function matchCommands(q: string, commands = PALETTE_COMMANDS) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands.filter((c) => {
    const hay = fold(`${c.group} ${c.label} ${c.keywords ?? ""}`);
    return words.every((w) => hay.includes(w));
  });
}
