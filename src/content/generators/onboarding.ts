// Questions du générateur d'onboarding. CONTENU MODIFIABLE sans toucher à la logique (voir proposition.ts).
import type { Question } from "@/lib/generators/rules";

export const ONBOARDING_QUESTIONS: Question[] = [
  { key: "interlocuteurs", section: "Équipe", label: "Qui sont les interlocuteurs, et quel est le rôle de chacun ?", type: "long", required: true },
  { key: "acces", section: "Accès et outils", label: "Quels accès faut-il obtenir ?", type: "long", required: true, help: "Site, analytics, publicité, CRM, réseaux sociaux…" },
  { key: "outils", section: "Accès et outils", label: "Quels outils le client utilise-t-il ?", type: "long" },
  { key: "date_lancement", section: "Démarrage", label: "Date de lancement", type: "date", required: true },
  { key: "rituels", section: "Démarrage", label: "Quels rituels de suivi ?", type: "long", required: true, help: "Point hebdomadaire, bilan mensuel, canal d'échange…" },
  { key: "premieres_actions", section: "Démarrage", label: "Quelles sont les premières actions ?", type: "long", required: true },
  { key: "vigilance", section: "Vigilance", label: "Points de vigilance", type: "long", help: "Ce qui peut freiner le démarrage ou fâcher le client." },
];
