// Espace Connecteurs : types partagés (serveur et navigateur). Aucun secret n'y transite :
// uniquement des états, des dates, des comptes affichables et des messages lisibles.

export type ConnectorKey = "gmail" | "google_calendar" | "fireflies" | "claude_mcp" | "ubersuggest";

export type ConnectorState =
  | "connected" // autorisation active confirmée
  | "reconnect" // accès expiré ou révoqué
  | "sync_error" // connexion active, dernier traitement en échec
  | "to_verify" // configuration présente, première vérification nécessaire
  | "not_connected" // aucune connexion active
  | "claude" // géré dans Claude, hors du CRM
  | "unknown"; // état non vérifiable

export const STATE_LABEL: Record<ConnectorState, string> = {
  connected: "Connecté",
  reconnect: "À reconnecter",
  sync_error: "Erreur de synchronisation",
  to_verify: "Configuré, à vérifier",
  not_connected: "Non connecté",
  claude: "Géré dans Claude",
  unknown: "État non vérifiable",
};

export type ConnectorGroup = "attention" | "connected" | "setup";
export const groupOf = (s: ConnectorState): ConnectorGroup =>
  s === "connected" || s === "claude" ? "connected" : s === "not_connected" ? "setup" : "attention";

export type Dated = { at: string; label: string };
export type Problem = { at: string | null; message: string };

export type ConnectorAction =
  | { kind: "verify"; label: string }
  | { kind: "link"; label: string; href: string; external?: boolean }
  | { kind: "manage"; label: string };

export type DetailItem = { label: string; value: string; tone?: "ok" | "warn" | "muted" };

export type McpGrant = { clientId: string; name: string; scopes: string[]; grantedAt: string | null };

export type Connector = {
  key: ConnectorKey;
  name: string;
  usage: string;
  state: ConnectorState;
  /** compte, adresse ou agenda connecté, si connu */
  account: string | null;
  /** dernière synchronisation / opération réussie, si le service en a */
  lastSuccess: Dated | null;
  /** dernier problème connu, s'il existe */
  problem: Problem | null;
  /** courte phrase sous le nom (ce qui est vérifié, ce qui manque) */
  note: string | null;
  primary: ConnectorAction;
  lastCheck: { at: string; ok: boolean; message: string | null } | null;
  // --- détail (panneau « Gérer ») ---
  feeds: string[];
  permissions: string[];
  settings: DetailItem[];
  links: { label: string; href: string }[];
  canVerify: boolean;
  reconnectHref: string | null;
  disconnect: { label: string; effect: string } | null;
  external: string | null; // ce qui se règle hors du CRM
  mcp?: { url: string; auth: string; grants: McpGrant[] | null; grantsError: string | null; lastWrite: string | null; shared: boolean };
};
