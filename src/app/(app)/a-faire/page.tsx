import { redirect } from "next/navigation";

// Ancienne adresse : « À faire » puis « Aujourd'hui » sont remplacés par l'Accueil.
export default function AFairePage() {
  redirect("/");
}
