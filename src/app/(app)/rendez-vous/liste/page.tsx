import { redirect } from "next/navigation";
import { withQuery } from "../redirect-query";

// Ancienne adresse de la liste (encore présente dans les événements Google : /rendez-vous/liste?rdv=<id>) :
// la liste est désormais une vue de l'Agenda. Filtres et ?rdv= sont conservés.
export default async function RdvListRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery("/rendez-vous/agenda", await searchParams, { vue: "liste" }));
}
