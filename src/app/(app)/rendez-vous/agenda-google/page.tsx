import { requireOwner } from "@/lib/auth";
import { configStatus } from "@/lib/appointments/config";
import { getGoogleConnection } from "@/lib/appointments/owner";
import { PageHeader } from "@/components/ui";
import { GoogleView } from "./google-view";

const ERRORS: Record<string, string> = {
  config: "Connexion impossible : les identifiants Google ou APPOINTMENTS_SECRET ne sont pas configurés sur le serveur.",
  refus: "Vous avez refusé l'accès dans Google. Aucun agenda n'a été connecté.",
  etat: "La demande de connexion a expiré ou n'est pas valide. Recommencez.",
  permissions: "Toutes les permissions nécessaires n'ont pas été accordées (cochez les trois cases proposées par Google).",
  "hors-ligne": "Google n'a pas fourni d'accès durable. Retirez l'accès de l'application dans votre compte Google, puis reconnectez.",
  enregistrement: "La connexion n'a pas pu être enregistrée. Réessayez.",
  google: "Google a refusé la connexion. Vérifiez la configuration du projet Google Cloud (URI de redirection, API Calendar activée).",
};

export default async function GooglePage({ searchParams }: { searchParams: Promise<{ erreur?: string; connecte?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const [conn, backlog] = await Promise.all([
    getGoogleConnection(supabase),
    supabase.from("appt_booking_overview").select("id", { count: "exact", head: true }).eq("calendar_out_of_sync", true),
  ]);
  return (
    <div>
      <PageHeader title="Connexion agenda" description="Google Agenda : vérification des indisponibilités et création des événements." />
      <GoogleView
        connection={conn}
        config={configStatus()}
        outOfSync={backlog.count ?? 0}
        error={sp.erreur ? (ERRORS[sp.erreur] ?? ERRORS.google) : null}
        justConnected={sp.connecte === "1"}
      />
    </div>
  );
}
