// Libellés français du module Finance.
import type { ExpenseStatus, InvoiceStatus, MissionStatus, Regime } from "./types";
import type { UrssafState } from "./calc";

export const MISSION_STATUS: Record<MissionStatus, string> = { a_demarrer: "À démarrer", actif: "Actif", en_pause: "En pause", termine: "Terminé" };
export const MISSION_KIND = { ponctuel: "Ponctuel", recurrent: "Récurrent" } as const;
export const FREQUENCY = { mensuel: "Mensuel", trimestriel: "Trimestriel", annuel: "Annuel" } as const;
export const INVOICE_STATUS: Record<InvoiceStatus, string> = {
  a_encaisser: "À encaisser",
  partielle: "Partiellement payée",
  payee: "Payée",
  en_retard: "En retard",
  annulee: "Annulée",
  avoir: "Avoir",
};
export const EXPENSE_STATUS: Record<ExpenseStatus, string> = { a_payer: "À payer", paye: "Payé", annule: "Annulé" };
export const URSSAF_STATE: Record<UrssafState, string> = { a_preparer: "À préparer", a_declarer: "À déclarer", declare: "Déclaré, à payer", paye: "Payé" };
export const REGIME: Record<Regime, string> = {
  micro_bnc_ssi: "Micro-entrepreneur · BNC (régime général / SSI)",
  micro_bnc_cipav: "Micro-entrepreneur · BNC (CIPAV)",
  micro_bic_services: "Micro-entrepreneur · BIC prestations de services",
  micro_bic_vente: "Micro-entrepreneur · BIC vente de marchandises",
  manual: "Autre statut (EI au réel, SASU, EURL…) · suivi manuel",
};
export const PERIODICITY = { monthly: "Mensuelle", quarterly: "Trimestrielle" } as const;
