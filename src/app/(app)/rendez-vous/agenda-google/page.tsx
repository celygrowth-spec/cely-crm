import { redirect } from "next/navigation";
import { withQuery } from "../redirect-query";

// Ancienne adresse de la connexion Google Agenda : elle vit dans Paramètres › Connecteurs.
// Les retours de connexion (?erreur=, ?connecte=1) sont conservés.
export default async function GoogleAgendaRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery("/parametres/connecteurs/google-agenda", await searchParams));
}
