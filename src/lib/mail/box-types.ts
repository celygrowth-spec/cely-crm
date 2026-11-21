// Types partagés navigateur / serveur pour la boîte Gmail. Aucun jeton ne transite par ces types.
export type BoxStatus = {
  /** none : pas de compte ; pending : jamais lancée ; initial : première lecture en cours ; ready : à jour ; error : à traiter */
  state: "none" | "pending" | "initial" | "ready" | "error";
  email: string | null;
  message: string;
  messages: number;
  last_sync_at: string | null;
  started_at: string | null;
};
