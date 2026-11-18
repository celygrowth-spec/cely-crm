// Questions du générateur de proposition. CONTENU MODIFIABLE sans toucher à la logique :
// changez un libellé, une aide, une option, l'ordre, ou ajoutez une question (clé unique, en minuscules).
// Ne changez pas la clé d'une question existante : les réponses déjà enregistrées y sont rattachées.
//   required : la génération attend cette réponse.   make : la réponse part aussi à Make, pour le devis.
//   internal : la réponse reste dans le CRM, elle ne part pas à l'IA (coordonnées de facturation).
import type { Question } from "@/lib/generators/rules";

export const DISCOVERY_OFFER = "decouverte";

export const PROPOSAL_QUESTIONS: Question[] = [
  // --- Offre ---
  { key: "offre", section: "Offre", label: "Quelle offre proposez-vous ?", type: "choice", required: true, make: true,
    options: [
      { value: "growth_part_time", label: "Growth Part-Time" },
      { value: DISCOVERY_OFFER, label: "Offre découverte" },
      { value: "audit", label: "Audit" },
      { value: "autre", label: "Autre (à préciser)" },
    ] },
  { key: "offre_precisions", section: "Offre", label: "Précisions sur l'offre", type: "long", help: "Ce qui la rend adaptée à ce client, ou le détail d'une offre « Autre »." },

  // --- Objectifs ---
  { key: "objectifs", section: "Objectifs", label: "Quels sont les objectifs du client ?", type: "long", required: true, help: "Dans ses mots quand c'est possible." },
  { key: "indicateurs", section: "Objectifs", label: "Quels indicateurs diront que c'est réussi ?", type: "long", required: true, help: "Chiffres visés, échéance, point de départ connu." },

  // --- Périmètre ---
  { key: "canaux", section: "Périmètre", label: "Quels canaux sont concernés ?", type: "long", required: true, help: "SEO, LinkedIn, emailing, publicité…" },
  { key: "perimetre", section: "Périmètre", label: "Que comprend la mission ?", type: "long", required: true },
  { key: "exclusions", section: "Périmètre", label: "Qu'est-ce qui est exclu ?", type: "long", required: true, help: "Ce qui n'est pas écrit ici sera supposé inclus." },

  // --- Volume, prix, options ---
  { key: "volume_horaire", section: "Volume et prix", label: "Quel volume de travail ?", type: "text", required: true, help: "Ex. : 2 jours par semaine, 20 heures par mois." },
  { key: "lignes_devis", section: "Volume et prix", label: "Lignes du devis", type: "lines", required: true, make: true,
    help: "Ces lignes partent telles quelles à Make : les montants du devis viennent d'ici, pas de l'IA." },
  { key: "options", section: "Volume et prix", label: "Options proposées", type: "long", help: "Ce que le client peut ajouter, avec son prix." },
  { key: "conditions_paiement", section: "Volume et prix", label: "Conditions de paiement", type: "text", required: true, make: true, help: "Ex. : mensuel, à 30 jours." },

  // --- Calendrier ---
  { key: "date_demarrage", section: "Calendrier", label: "Date de démarrage", type: "date", required: true, make: true },
  { key: "duree_mois", section: "Calendrier", label: "Durée, en mois", type: "number", required: true, make: true },

  // --- Signataire et facturation ---
  { key: "signataire", section: "Signataire et facturation", label: "Qui signe ?", type: "person", required: true, make: true },
  { key: "raison_sociale", section: "Signataire et facturation", label: "Raison sociale à facturer", type: "text", required: true, make: true },
  { key: "siret", section: "Signataire et facturation", label: "SIRET", type: "text", make: true, internal: true },
  { key: "tva_intracom", section: "Signataire et facturation", label: "Numéro de TVA", type: "text", make: true, internal: true },
  { key: "adresse_facturation", section: "Signataire et facturation", label: "Adresse de facturation", type: "text", required: true, make: true, internal: true },
  { key: "code_postal", section: "Signataire et facturation", label: "Code postal", type: "text", required: true, make: true, internal: true },
  { key: "ville", section: "Signataire et facturation", label: "Ville", type: "text", required: true, make: true, internal: true },
  { key: "pays", section: "Signataire et facturation", label: "Pays (code à deux lettres)", type: "text", required: true, make: true, internal: true },

  // --- Conditions particulières ---
  { key: "conditions_particulieres", section: "Conditions particulières", label: "Conditions particulières", type: "long", make: true, help: "Préavis, engagement, clause propre à ce client." },

  // --- Ton ---
  { key: "ton", section: "Ton", label: "Quel ton adopter ?", type: "choice",
    options: [{ value: "direct", label: "Direct et factuel" }, { value: "pedagogue", label: "Pédagogue" }, { value: "premium", label: "Haut de gamme" }] },
  { key: "points_sensibles", section: "Ton", label: "Points sensibles à éviter", type: "long", help: "Sujets, mots ou comparaisons à ne pas employer." },
];
