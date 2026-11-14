// Types partagés (serveur et navigateur) des comptes lemlist. Aucune clé n'y figure, même chiffrée.

export type LemlistAccountStatus = "connected" | "needs_reconnect" | "disconnected";

export type LemlistAccount = {
  id: string;
  company_id: string;
  company_name: string;
  company_archived: boolean;
  team_id: string;
  team_name: string;
  status: LemlistAccountStatus;
  last_error: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  connected_at: string;
};

export type LemlistClientOption = { id: string; name: string; archived: boolean };

export type LemlistOverview = { configured: boolean; accounts: LemlistAccount[]; clients: LemlistClientOption[] };

export const LEMLIST_STATUS_LABEL: Record<LemlistAccountStatus, string> = {
  connected: "Connecté",
  needs_reconnect: "À reconnecter",
  disconnected: "Déconnecté",
};
